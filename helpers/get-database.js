/**
 * Copyright (c) Forward Email LLC
 * SPDX-License-Identifier: BUSL-1.1
 */

const fs = require('node:fs');
const path = require('node:path');

// <https://github.com/knex/knex-schema-inspector/pull/146>
const Database = require('better-sqlite3-multiple-ciphers');
const _ = require('lodash');
const isSANB = require('is-string-and-not-blank');
const knex = require('knex');
const ms = require('ms');
const pify = require('pify');
const { Builder } = require('json-sql');
const { SchemaInspector } = require('knex-schema-inspector');

const Attachments = require('#models/attachments');
const Mailboxes = require('#models/mailboxes');
const Messages = require('#models/messages');
const TemporaryMessages = require('#models/temporary-messages');
const Threads = require('#models/threads');
const combineErrors = require('#helpers/combine-errors');
const config = require('#config');
const env = require('#config/env');
const getPathToDatabase = require('#helpers/get-path-to-database');
const logger = require('#helpers/logger');
const onAppend = require('#helpers/imap/on-append');
const setupPragma = require('#helpers/setup-pragma');
const { encrypt } = require('#helpers/encrypt-decrypt');
const { acquireLock, releaseLock } = require('#helpers/lock');
const { convertResult } = require('#helpers/mongoose-to-sqlite');

const onAppendPromise = pify(onAppend);
const builder = new Builder();

// eslint-disable-next-line complexity
async function migrateSchema(alias, db, session, tables) {
  // indices store for index list (which we use for conditionally adding indices)
  const indexList = {};

  // attempt to use knex
  // <https://github.com/m4heshd/better-sqlite3-multiple-ciphers/issues/69>

  //
  // this is too verbose so we're just giving it noops for now
  // (useful to turn this on if you need to debug knex stuff)
  //
  const log = {
    warn() {},
    error() {},
    deprecate() {},
    debug() {}
  };
  /*
    const log =
      config.env === 'development'
        ? {
            warn(...args) {
              console.warn('knex', ...args);
            },
            error(...args) {
              console.error('knex', ...args);
            },
            deprecate(...args) {
              console.error('knex', ...args);
            },
            debug(...args) {
              console.debug('knex', ...args);
            }
          }
        : {
            warn() {},
            error() {},
            deprecate() {},
            debug() {}
          };
    */

  const knexDatabase = knex({
    client: 'better-sqlite3',
    connection: {
      filename: db.name,
      options: {
        nativeBinding
      }
    },
    debug: config.env === 'development',
    acquireConnectionTimeout: ms('15s'),
    log,
    useNullAsDefault: true,
    pool: {
      // <https://knexjs.org/faq/recipes.html#db-access-using-sqlite-and-sqlcipher>
      async afterCreate(db, fn) {
        await setupPragma(db, session);
        //
        // when you run `db.pragma('index_list(table)')` it will return output like:
        //
        // [
        //   { seq: 0, name: 'specialUse', unique: 0, origin: 'c', partial: 0 },
        //   { seq: 1, name: 'subscribed', unique: 0, origin: 'c', partial: 0 },
        //   { seq: 2, name: 'path', unique: 0, origin: 'c', partial: 0 },
        //   { seq: 3, name: '_id', unique: 1, origin: 'c', partial: 0 },
        //   {
        //     seq: 4,
        //     name: 'sqlite_autoindex_mailboxes_1',
        //     unique: 1,
        //     origin: 'pk',
        //     partial: 0
        //   }
        // ]
        //
        // <https://www.sqlite.org/pragma.html#pragma_index_list>
        //
        // we do this in advance in order to add missing indices if and only if needed
        //
        for (const table of Object.keys(tables)) {
          try {
            indexList[table] = db.pragma(`index_list(${table})`);
            // TODO: drop other indices that aren't necessary (?)
          } catch (err) {
            logger.error(err, { alias, session });
          }
        }

        fn();
      }
    }
  });

  const inspector = new SchemaInspector(knexDatabase);

  // ensure that all tables exist
  const errors = [];
  const commands = [];
  for (const table of Object.keys(tables)) {
    // <https://github.com/knex/knex/issues/360#issuecomment-1692481083>
    // eslint-disable-next-line no-await-in-loop
    const hasTable = await inspector.hasTable(table);
    if (!hasTable) {
      // create table
      commands.push(tables[table].createStatement);

      // add columns
      for (const key of Object.keys(tables[table].mapping)) {
        if (tables[table].mapping[key].alterStatement)
          commands.push(tables[table].mapping[key].alterStatement);
        // TODO: conditionally add indexes using `indexList[table]`
        if (tables[table].mapping[key].indexStatement)
          commands.push(tables[table].mapping[key].indexStatement);
        // conditionally add FTS5
        if (tables[table].mapping[key].fts5) {
          const exists = hasFTS5Already(db, table);
          if (!exists) commands.push(...tables[table].mapping[key].fts5);
        }
      }

      continue;
    }

    // ensure that all columns exist using mapping for the table
    // eslint-disable-next-line no-await-in-loop
    const columnInfo = await inspector.columnInfo(table);
    // create mapping of columns by their key for easy lookup
    const columnInfoByKey = _.zipObject(
      columnInfo.map((c) => c.name),
      columnInfo
    );
    // TODO: drop other columns that we don't need (?)
    for (const key of Object.keys(tables[table].mapping)) {
      const column = columnInfoByKey[key];
      if (!column) {
        // we don't run ALTER TABLE commands unless we need to
        if (tables[table].mapping[key].alterStatement)
          commands.push(tables[table].mapping[key].alterStatement);
        // TODO: conditionally add indexes using `indexList[table]`
        if (tables[table].mapping[key].indexStatement)
          commands.push(tables[table].mapping[key].indexStatement);
        // conditionally add FTS5
        if (tables[table].mapping[key].fts5) {
          const exists = hasFTS5Already(db, table);
          if (!exists) commands.push(...tables[table].mapping[key].fts5);
        }

        continue;
      }

      // conditionally add indexes using `indexList[table]`
      if (tables[table].mapping[key].indexStatement) {
        //
        // if the index doesn't match up
        // (e.g. `unique` is 1 when should be 0)
        // (or if `partial` is 1 - the default should be 0)
        // then we can drop the existing index and add the proper one
        // but note that if it's "id" then it needs both autoindex and normal index
        //
        const existingIndex = indexList[table].find((obj) => {
          return obj.name === `${table}_${key}`;
        });

        if (existingIndex) {
          if (
            existingIndex.partial !== 0 ||
            Boolean(existingIndex.unique) !==
              tables[table].mapping[key].is_unique ||
            existingIndex.origin !== 'c'
          ) {
            // drop it and add it back
            commands.push(
              `DROP INDEX IF EXISTS "${table}_${key}" ON ${table}`,
              tables[table].mapping[key].indexStatement
            );
          }
          // TODO: ensure primary key index (e.g. name = sqlite_autoindex_mailboxes_1) see above
          //       (origin = 'pk')
        } else {
          commands.push(tables[table].mapping[key].indexStatement);
        }
      }

      // conditionally add FTS5
      if (tables[table].mapping[key].fts5) {
        const exists = hasFTS5Already(db, table);
        if (!exists) commands.push(...tables[table].mapping[key].fts5);
      }

      //
      // NOTE: sqlite does not support altering data types
      //       (so manual migration would be required)
      //       (e.g. which we would write to rename the col, add the proper one, then migrate the data)
      //       <https://stackoverflow.com/a/2083562>
      //       <https://sqlite.org/omitted.html>
      //
      // TODO: therefore if any of these changed from the mapping value
      // then we need to log a code bug error and throw it
      // (store all errors in an array and then use combine errors)
      for (const prop of COLUMN_PROPERTIES) {
        if (column[prop] !== tables[table].mapping[key][prop]) {
          //
          // TODO: note that we would need to lock/unlock database for this
          // TODO: this is where we'd write the migration necessary
          // TODO: rename the table to __table, then add the proper table with columns
          // TODO: and then we would need to copy back over the data and afterwards delete __table
          // TODO: this should be run inside a `transaction()` with rollback
          //
          // NOTE: for now in the interim we're going to simply log it as a code bug
          //
          errors.push(
            `Column "${key}" in table "${table}" has property "${prop}" with definition "${column[prop]}" when it needs to be "${tables[table].mapping[key][prop]}" to match the current schema`
          );
        }
      }
    }
  }

  // we simply log a code bug for any migration errors (e.g. conflict on null/default values)
  if (errors.length > 0) {
    const err = combineErrors(errors);
    err.isCodeBug = true; // will email admins and text them
    await logger.fatal(err, { alias, session });
  }

  //
  // NOTE: how do you access raw db knex connection (?)
  // <https://github.com/knex/knex/issues/5720>
  //
  await knexDatabase.destroy();

  return commands;
}

async function checkTemporaryStorage(instance, session, alias) {
  const filePath = path.join(
    path.dirname(session.db.name),
    `${alias.id}-tmp.sqlite`
  );

  const tmpDb = new Database(filePath, {
    // if the db wasn't found it means there wasn't any mail
    // fileMustExist: true,
    timeout: config.busyTimeout,
    // <https://github.com/WiseLibs/better-sqlite3/issues/217#issuecomment-456535384>
    verbose: config.env === 'development' ? console.log : null
  });
  session.tmpDb = tmpDb;

  const tmpSession = {
    ...session,
    user: {
      ...session.user,
      password: encrypt(env.API_SECRETS[0])
    }
  };

  await setupPragma(tmpDb, tmpSession);

  // migrate schema
  const commands = await migrateSchema(alias, tmpDb, tmpSession, {
    TemporaryMessages
  });

  const lock = await acquireLock(instance, tmpDb);

  if (commands.length > 0) {
    for (const command of commands) {
      try {
        // TODO: wsp here (?)
        tmpDb.prepare(command).run();
        // await knexDatabase.raw(command);
      } catch (err) {
        err.isCodeBug = true;
        // eslint-disable-next-line no-await-in-loop
        await logger.fatal(err, { command, alias, session });
      }
    }
  }

  // copy and purge messages
  try {
    const sql = builder.build({
      type: 'select',
      table: 'TemporaryMessages'
    });
    const results = tmpDb.prepare(sql.query).all(sql.values);
    for (const result of results) {
      //
      // if one message fails then not all of them should
      // (e.g. one might have an issue with `date` or `raw`)
      //
      try {
        // eslint-disable-next-line no-await-in-loop
        const message = await convertResult(TemporaryMessages, result);

        // eslint-disable-next-line no-await-in-loop
        const results = await onAppendPromise.call(
          instance,
          'INBOX',
          [],
          message.date,
          message.raw,
          {
            ...session,
            remoteAddress: message.remoteAddress
          }
        );

        logger.debug('results', { results });

        // if successfully appended then delete from the database
        const sql = builder.build({
          type: 'remove',
          table: 'TemporaryMessages',
          condition: {
            _id: message._id.toString()
          }
        });
        const response = tmpDb.prepare(sql.query).run(sql.values);
        if (typeof response?.changes !== 'number')
          throw new TypeError('Result should be a number');
      } catch (err) {
        logger.fatal(err, { alias, session });
      }
    }
  } catch (err) {
    logger.fatal(err, { alias, session });
  }

  // release lock
  try {
    await releaseLock(instance, tmpDb, lock);
  } catch (err) {
    logger.fatal(err, { session, alias });
  }

  return tmpDb;
}

// <https://www.sqlite.org/pragma.html#pragma_table_list>
function hasFTS5Already(db, table) {
  // [
  //   {
  //     schema: 'main',
  //     name: 'Messages',
  //     type: 'table',
  //     ncol: 33,
  //     wr: 0,
  //     strict: 0
  //   },
  //   {
  //     schema: 'main',
  //     name: 'Messages_fts',
  //     type: 'virtual',
  //     ncol: 4,
  //     wr: 0,
  //     strict: 0
  //   },
  //   ...
  // ]
  const tables = db.pragma(`table_list(${table}_fts)`);
  return tables.length > 0;
}

const nativeBinding = path.join(
  __dirname,
  '..',
  'node_modules',
  'better-sqlite3-multiple-ciphers',
  'build',
  'Release',
  'better_sqlite3.node'
);

//
// ALTER TABLE notes:
// - [x] cannot be UNIQUE or PRIMARY KEY
// - [x] NOT NULL without default value
// - [x] cannot have default of time/date related
// - [x] foreign key with foreign key constraint must allow NULL
//

const COLUMN_PROPERTIES = [
  'data_type',
  'default_value',
  'max_length',
  'numeric_precision',
  'numeric_scale',
  'is_generated',
  'generation_expression',
  'is_nullable',
  'is_unique',
  'is_primary_key',
  'has_auto_increment',
  'foreign_key_column',
  'foreign_key_table'
];

// always ensure `rclone.conf` is an empty file
// function syncRcloneConfig() {
//   try {
//     fs.writeFileSync(rcloneConfigFilePath, '');
//   } catch (err) {
//     err.isCodeBug = true;
//     logger.fatal(err);
//   }
// }
// syncRcloneConfig();
// setInterval(syncRcloneConfig, 30000);

/*
const s3 = [
  `--s3-provider="Cloudflare"`,
  `--s3-access-key-id="${env.AWS_ACCESS_KEY_ID}"`,
  `--s3-secret-access-key="${env.AWS_SECRET_ACCESS_KEY}"`,
  `--s3-region="${env.AWS_REGION}"`,
  `--s3-endpoint="${env.AWS_ENDPOINT_URL}"`
];

function touchFile(s3, fileName) {
  return new Promise((resolve, reject) => {
    //
    // the flag `--s3-no-check-bucket` is required in order for this to work
    // <https://github.com/rclone/rclone/issues/4589#issuecomment-694897762>
    // <https://rclone.org/s3/#s3-no-check-bucket>
    //
    const cmds = [
      'touch',
      ...s3,
      '-vvv',
      `--config "${rcloneConfigFilePath}"`,
      '--s3-no-check-bucket',
      `:s3:${bucketName}/${fileName}`
    ];
    console.log('cmds', cmds.join(' '));
    // NOTE: if we had wanted to go size approach it would have looked like this
    // const cmds = [
    //   'size',
    //   '--dry-run',
    //   '--exclude "*"',
    //   '--max-depth 0',
    //   ...s3,
    //   `:s3:${bucketName}/`
    // ],
    const cmd = spawn('rclone', cmds, {
      shell: true,
      // TODO: limit env path to rclone
      // env: {},
      timeout: ms('15s')
    });
    cmd.stdout.on('data', (data) => {
      console.log(String(data));
    });
    cmd.stderr.on('data', (data) => {
      console.log(String(data));
    });
    cmd.on('close', (code) => resolve(code));
    cmd.on('error', (err) => reject(err));
  });
}
*/

// eslint-disable-next-line complexity, max-params
async function getDatabase(
  instance,
  alias,
  session,
  existingLock,
  newlyCreated = false
) {
  // return early if the session.db was already assigned
  if (
    session.db &&
    (session.db instanceof Database || session.db.wsp) &&
    session.db.open === true
  )
    return { db: session.db, tmpDb: session.tmpDb };

  // instance must be either IMAP or SQLite
  if (!['IMAP', 'SQLite'].includes(instance?.constructor?.name))
    throw new TypeError('Instance must be either SQLite or IMAP');

  // safeguard
  if (!isSANB(alias?.id)) throw new TypeError('Alias ID missing');

  // safeguard
  if (!isSANB(session?.user?.password)) throw new TypeError('Password missing');

  // if true then `?mode=ro` will get appended below
  // <https://www.sqlite.org/c3ref/open.html>
  // <https://github.com/knex/knex/issues/1287>
  let readonly = true;
  if (instance?.constructor?.name === 'SQLite') readonly = false;

  //
  // we will substitute global with the unique bucket configuration hash
  // (e.g. rev-hash() on the parameters and maybe encrypt() too)
  //
  // TODO: instead of `global` it should be the default global bucket for the alias
  //       (e.g. `alias.bucket = 'production-xyz')
  //
  // const readmeFilePath = path.join(dir, readmeFileName);
  const dbFilePath = getPathToDatabase(alias);

  //
  // NOTE: if readonly and database doesn't exist it will throw an error
  //       so we need to signal to the websocket server to create it
  //
  if (readonly) {
    let exists = false;
    if (env.SQLITE_RCLONE_ENABLED) {
      try {
        const stats = await fs.promises.stat(dbFilePath);
        if (stats.isFile()) exists = true;
      } catch (err) {
        err.isCodeBug = true; // hide error from end users
        if (err.code !== 'ENOENT') throw err;
      }
    }

    if (!exists) {
      if (instance?.constructor?.name !== 'IMAP')
        throw new TypeError('IMAP server instance required');

      if (
        instance?.wsp?.constructor?.name !== 'WebSocketAsPromised' &&
        (!instance?.wsp || !instance.wsp[Symbol.for('isWSP')])
      )
        throw new TypeError('WebSocketAsPromised instance required');

      //
      // if we already recursively called this function from
      // a successful webhook response, then that must mean something
      // is wrong with the local file system or rclone mount
      //
      if (newlyCreated) {
        if (env.SQLITE_RCLONE_ENABLED) {
          const err = new TypeError(
            'Newly created and still having readonly issues'
          );
          err.alias = alias;
          err.session = session;
          err.dbFilePath = dbFilePath;
          logger.fatal(err, { alias, session });
        }

        //
        // return a dummy object with `wsp: true`
        // which signals us to use the websocket connection
        // in a fallback attempt in case the rclone mount failed
        //
        const db = {
          id: alias.id,
          open: true,
          inTransaction: false,
          readonly: true,
          memory: false,
          wsp: true,
          close() {
            this.open = false;
          }
        };
        // set session db helper (used in `refineAndLogError` to close connection)
        session.db = db;
        return { db };
      }

      // note that this will throw an error if it parses one
      await instance.wsp.request({
        action: 'setup',
        lock: existingLock,
        session: { user: session.user }
      });

      // if rclone was not enabled then return early
      if (!env.SQLITE_RCLONE_ENABLED) {
        const db = {
          id: alias.id,
          open: true,
          inTransaction: false,
          readonly: true,
          memory: false,
          wsp: true,
          close() {
            this.open = false;
          }
        };
        // set session db helper (used in `refineAndLogError` to close connection)
        session.db = db;
        return { db };
      }

      // call this function again if it was successful
      return getDatabase(instance, alias, session, existingLock, true);
    }
  }

  //
  // check if the file exists at the given path
  // (if so, then we can assume that it's mounted)
  // (otherwise run size test, spawn daemon in background, pWaitFor (with 15s timeout), then continue)
  //
  //  try {
  //    const stats = await fs.promises.stat(dbFilePath);
  //    if (stats.isFile()) exists = true;
  //  } catch (err) {
  //    if (err.code !== 'ENOENT') throw err;
  //  }

  //
  // if file does not exist, then the README might exist
  // (which we add to all dirs with same naming convention)
  // (so that users don't accidentally delete the files)
  //
  /*
  console.time('mkdirp and exists');
  let exists = false;
  try {
    // <https://github.com/nodejs/node/issues/38006>
    // const stats = await fs.promises.stat(readmeFilePath);
    console.time('execsync test');
    const stats = fs.statSync(readmeFilePath);
    if (!stats.isFile())
      throw new TypeError('README did not exist at path as a file');
    exists = true;
    if (stats.size === 0) {
      // TODO: if the file is empty then write to it
      // TODO: write a README file for users with our disclaimer/website/email etc
      // TODO: this should come below after mounted
    }

    // try {
    //   const { stdout, stderr } = await execPromise(`test -f ${readmeFilePath}`);
    //   console.log('stdout', stdout);
    //   console.log('stderr', stderr);
    //   exists = true;
    // } catch {}

    console.timeEnd('execsync test');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    await mkdirp(dir);
  }
  console.timeEnd('mkdirp and exists');
  */

  //
  // TODO: some flags we might want to look into:
  // <https://forum.rclone.org/t/rclone-huge-performance-loss-upgrading-from-1-55-to-1-62/38209>
  //

  //
  // it doesn't seem like there's an easy way to test rclone connection
  // other than listing directories and files, which we don't want to do
  // (since this could be someone's sensitive bucket or directory)
  // <https://forum.rclone.org/t/how-to-test-remote-connection/28718/4>
  //
  // therefore we came up with a clever hack that uses `rclone size`
  // and excludes everything and doesn't recurse into directories
  // `rclone size --dry-run --exclude '*' --max-depth 0 ...`
  //
  // and the expected output must contain this:
  //
  // `Total objects: 0 (0)`
  // `Total size: 0 B (0 Byte)`
  //
  // but note we only want to try to run this when we don't already have a connection
  // and we also need to make sure we can actually write to the bucket
  // so a better solution is to attempt to `touch` and modify the timestamp of a file
  // (and create it if it doesn't already exist)

  /*
  console.log('exists', exists);

  if (!exists) {
    console.time('mounting');
    const stdout = '';
    const stderr = '';
    const touch = await Promise.all([
      touchFile(s3, dbFileName),
      touchFile(s3, readmeFileName)
    ]);
    console.log('touch', touch);
    console.log('stdout', stdout);
    console.log('stderr', stderr);

    if (touch[0] !== 0 || touch[1] !== 0)
      throw new TypeError('Touch error occurred');

    const mount = await new Promise((resolve, reject) => {
      const cmd = spawn(
        'rclone',
        [
          'mount',
          '--dump filters',
          `--config "${rcloneConfigFilePath}"`,
          '--debug-fuse',
          '--daemon',
          '--allow-non-empty',
          // TODO: redo this and only enable in non-production
          // '-vv', // <- can't set this if "--log-level" set too
          // '--log-level DEBUG',
          // `--log-file ${path.join(__dirname, '..', 'rclone-log.txt')}`,
          // '--no-modtime',
          // '--no-checksum',

          '--vfs-fast-fingerprint',
          '--vfs-cache-mode writes',
          // NOTE: this is useful for providers that don't support polling (?) not sure which ones yet though
          // <https://rclone.org/commands/rclone_mount/#vfs-directory-cache>
          '--dir-cache-time 10s', // default is 5m
          '--vfs-write-back 1s', // default is 5s
          '--vfs-cache-poll-interval 5s',
          '--poll-interval 1s',

          // NOTE: cache-dir should be unique unless we are certain daemon's won't spawn or overlap (could damage files)
          // --cache-dir string                     Directory rclone will use for caching.

          // --vfs-cache-mode CacheMode             Cache mode off|minimal|writes|full (default off)
          // --vfs-cache-max-age duration           Max time since last access of objects in the cache (default 1h0m0s)
          // --vfs-cache-max-size SizeSuffix        Max total size of objects in the cache (default off)
          // --vfs-cache-min-free-space SizeSuffix  Target minimum free space on the disk containing the cache (default off)
          // --vfs-cache-poll-interval duration     Interval to poll the cache for stale objects (default 1m0s)
          // --vfs-write-back duration              Time to writeback files after last use when using cache (default 5s)
          //
          // TODO: we most likely need to adjust interval and introduce better locking
          // <https://rclone.org/commands/rclone_mount/#vfs-file-caching>
          //
          '--max-depth 0',
          // filter for the readme and db file only
          `--include "${readmeFileName}"`,
          `--include "${dbFileName}"`,
          // TODO: probably can remove this since new storage method
          `--include ".forwardemail-mailbox-*.db"`,
          ...s3,
          `:s3:${bucketName}/`,
          dir
        ],
        {
          shell: true,
          // TODO: limit env path to rclone
          // env: {},
          timeout: ms('15s')
        }
      );
      cmd.stdout.on('data', (data) => {
        console.log('stdout', String(data));
      });
      cmd.stderr.on('data', (data) => {
        console.log('stderr', String(data));
      });
      cmd.on('close', (code) => resolve(code));
      cmd.on('error', (err) => reject(err));
    });

    console.log('mount', mount);

    if (mount !== 0) throw new TypeError('Mount error occurred');

    console.time('pWaitFor');
    // TODO: if a timeout occurs here then we should attempt to kill rclone
    // TODO: we should also notify admins of the error
    // wait for file to appear locally on vfs
    await pWaitFor(
      () => {
        try {
          // <https://github.com/nodejs/node/issues/38006>
          // const stats = await fs.promises.stat(dbFilePath);
          const stats = fs.statSync(dbFilePath);
          return stats.isFile();
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
          return false;
        }
      },
      {
        timeout: ms('15s')
      }
    );
    console.timeEnd('pWaitFor');
    console.timeEnd('mounting');
  }
  */

  let db;
  let tmpDb;
  let lock;

  try {
    db = new Database(dbFilePath, {
      readonly,
      fileMustExist: readonly,
      timeout: config.busyTimeout,
      // <https://github.com/WiseLibs/better-sqlite3/issues/217#issuecomment-456535384>
      verbose: config.env === 'development' ? console.log : null
    });
    if (!db.lock) db.lock = existingLock;

    await setupPragma(db, session);

    // TODO: need to rewrite this
    // set session db helper (used in `refineAndLogError` to close connection)
    session.db = db;

    // if it is readonly then return early
    if (readonly) return { db };

    // migrate schema
    const commands = await migrateSchema(alias, db, session, {
      Mailboxes,
      Messages,
      Threads,
      Attachments
    });

    if (!existingLock || existingLock?.success !== true)
      lock = await acquireLock(instance, db);

    if (commands.length > 0) {
      for (const command of commands) {
        try {
          // TODO: wsp here (?)
          db.prepare(command).run();
          // await knexDatabase.raw(command);
        } catch (err) {
          err.isCodeBug = true;
          // eslint-disable-next-line no-await-in-loop
          await logger.fatal(err, { command, alias, session });
        }
      }
    }

    // release lock
    try {
      if (lock) await releaseLock(instance, db, lock);
    } catch (err) {
      logger.fatal(err, { alias, session });
    }

    try {
      tmpDb = await checkTemporaryStorage(instance, session, alias);
    } catch (err) {
      logger.error(err, { alias, session });
    }

    return { db, tmpDb };
  } catch (err) {
    // release lock
    if (lock) {
      try {
        await releaseLock(instance, db, lock);
      } catch (err) {
        logger.fatal(err, { alias, session });
      }
    }

    // <https://sqlite.org/c3ref/c_abort.html>
    // <https://www.sqlite.org/rescode.html>
    // SQLITE_FULL: database or disk full
    // SQLITE_IOERR: disk I/O error
    // SQLITE_BUSY: database in use by another process
    // SQLITE_NOMEM: out of memory
    // <https://sqlite.org/pragma.html#pragma_user_version>
    // TODO: notify user here by sms/notification/email of any issues
    // if (err.code === 'SQLITE_NOTADB') throw new Error('Bad password');
    throw err;
  }
}

module.exports = getDatabase;