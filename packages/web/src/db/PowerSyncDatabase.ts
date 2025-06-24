import {
  type BucketStorageAdapter,
  type PowerSyncBackendConnector,
  type PowerSyncCloseOptions,
  type RequiredAdditionalConnectionOptions,
  AbstractPowerSyncDatabase,
  DBAdapter,
  DEFAULT_POWERSYNC_CLOSE_OPTIONS,
  isDBAdapter,
  isSQLOpenFactory,
  PowerSyncDatabaseOptions,
  PowerSyncDatabaseOptionsWithDBAdapter,
  PowerSyncDatabaseOptionsWithOpenFactory,
  PowerSyncDatabaseOptionsWithSettings,
  SqliteBucketStorage,
  StreamingSyncImplementation
} from '@powersync/common';
import { Mutex } from 'async-mutex';
import { getNavigatorLocks } from '../shared/navigator';
import { WASQLiteOpenFactory } from './adapters/wa-sqlite/WASQLiteOpenFactory';
import {
  DEFAULT_WEB_SQL_FLAGS,
  ResolvedWebSQLOpenOptions,
  resolveWebSQLFlags,
  WebSQLFlags
} from './adapters/web-sql-flags';
import { WebDBAdapter } from './adapters/WebDBAdapter';
import { SharedWebStreamingSyncImplementation } from './sync/SharedWebStreamingSyncImplementation';
import { SSRStreamingSyncImplementation } from './sync/SSRWebStreamingSyncImplementation';
import { WebRemote } from './sync/WebRemote';
import {
  WebStreamingSyncImplementation,
  WebStreamingSyncImplementationOptions
} from './sync/WebStreamingSyncImplementation';

export interface WebPowerSyncFlags extends WebSQLFlags {
  /**
   * Externally unload open PowerSync database instances when the window closes.
   * Setting this to `true` requires calling `close` on all open PowerSyncDatabase
   * instances before the window unloads
   */
  externallyUnload?: boolean;
}

type WithWebFlags<Base> = Base & { flags?: WebPowerSyncFlags };

export interface WebSyncOptions {
  /**
   * Allows you to override the default sync worker.
   *
   * You can either provide a path to the worker script
   * or a factory method that returns a worker.
   */
  worker?: string | URL | ((options: ResolvedWebSQLOpenOptions) => SharedWorker);
}

type WithWebSyncOptions<Base> = Base & {
  sync?: WebSyncOptions;
};

export interface WebEncryptionOptions {
  /**
   * Encryption key for the database.
   * If set, the database will be encrypted using Multiple Ciphers.
   */
  encryptionKey?: string;
}

type WithWebEncryptionOptions<Base> = Base & WebEncryptionOptions;

export type WebPowerSyncDatabaseOptionsWithAdapter = WithWebSyncOptions<
  WithWebFlags<PowerSyncDatabaseOptionsWithDBAdapter>
>;
export type WebPowerSyncDatabaseOptionsWithOpenFactory = WithWebSyncOptions<
  WithWebFlags<PowerSyncDatabaseOptionsWithOpenFactory>
>;
export type WebPowerSyncDatabaseOptionsWithSettings = WithWebSyncOptions<
  WithWebFlags<WithWebEncryptionOptions<PowerSyncDatabaseOptionsWithSettings>>
>;

export type WebPowerSyncDatabaseOptions = WithWebSyncOptions<WithWebFlags<PowerSyncDatabaseOptions>>;

export const DEFAULT_POWERSYNC_FLAGS: Required<WebPowerSyncFlags> = {
  ...DEFAULT_WEB_SQL_FLAGS,
  externallyUnload: false
};

export const resolveWebPowerSyncFlags = (flags?: WebPowerSyncFlags): Required<WebPowerSyncFlags> => {
  return {
    ...DEFAULT_POWERSYNC_FLAGS,
    ...flags,
    ...resolveWebSQLFlags(flags)
  };
};

/**
 * Asserts that the database options are valid for custom database constructors.
 */
function assertValidDatabaseOptions(options: WebPowerSyncDatabaseOptions): void {
  if ('database' in options && 'encryptionKey' in options) {
    const { database } = options;
    if (isSQLOpenFactory(database) || isDBAdapter(database)) {
      throw new Error(
        `Invalid configuration: 'encryptionKey' should only be included inside the database object when using a custom ${isSQLOpenFactory(database) ? 'WASQLiteOpenFactory' : 'WASQLiteDBAdapter'} constructor.`
      );
    }
  }
}

/**
 * A PowerSync database which provides SQLite functionality
 * which is automatically synced.
 *
 * @example
 * ```typescript
 * export const db = new PowerSyncDatabase({
 *  schema: AppSchema,
 *  database: {
 *    dbFilename: 'example.db'
 *  }
 * });
 * ```
 */
export class PowerSyncDatabase extends AbstractPowerSyncDatabase {
  static SHARED_MUTEX = new Mutex();

  protected unloadListener?: () => Promise<void>;
  protected resolvedFlags: WebPowerSyncFlags;
  protected devtoolsAttached: boolean = false;

  constructor(options: WebPowerSyncDatabaseOptionsWithAdapter);
  constructor(options: WebPowerSyncDatabaseOptionsWithOpenFactory);
  constructor(options: WebPowerSyncDatabaseOptionsWithSettings);
  constructor(options: WebPowerSyncDatabaseOptions);
  constructor(protected options: WebPowerSyncDatabaseOptions) {
    super(options);

    assertValidDatabaseOptions(options);

    this.resolvedFlags = resolveWebPowerSyncFlags(options.flags);

    if (this.resolvedFlags.enableMultiTabs && !this.resolvedFlags.externallyUnload) {
      this.unloadListener = () => this.close({ disconnect: false });
      window.addEventListener('unload', this.unloadListener);
    }

    // Expose API for PowerSync Devtools
    if (process.env.NODE_ENV === 'development') {
      this.attachDevtoolsEventListeners();
    }
  }

  async _initialize(): Promise<void> {}

  protected openDBAdapter(options: WebPowerSyncDatabaseOptionsWithSettings): DBAdapter {
    const defaultFactory = new WASQLiteOpenFactory({
      ...options.database,
      flags: resolveWebPowerSyncFlags(options.flags),
      encryptionKey: options.encryptionKey
    });
    return defaultFactory.openDB();
  }

  /**
   * Closes the database connection.
   * By default the sync stream client is only disconnected if
   * multiple tabs are not enabled.
   */
  close(options: PowerSyncCloseOptions = DEFAULT_POWERSYNC_CLOSE_OPTIONS): Promise<void> {
    if (this.unloadListener) {
      window.removeEventListener('unload', this.unloadListener);
    }

    return super.close({
      // Don't disconnect by default if multiple tabs are enabled
      disconnect: options.disconnect ?? !this.resolvedFlags.enableMultiTabs
    });
  }

  protected generateBucketStorageAdapter(): BucketStorageAdapter {
    return new SqliteBucketStorage(this.database, AbstractPowerSyncDatabase.transactionMutex);
  }

  protected async runExclusive<T>(cb: () => Promise<T>) {
    if (this.resolvedFlags.ssrMode) {
      return PowerSyncDatabase.SHARED_MUTEX.runExclusive(cb);
    }
    return getNavigatorLocks().request(`lock-${this.database.name}`, cb);
  }

  protected generateSyncStreamImplementation(
    connector: PowerSyncBackendConnector,
    options: RequiredAdditionalConnectionOptions
  ): StreamingSyncImplementation {
    const remote = new WebRemote(connector);
    const syncOptions: WebStreamingSyncImplementationOptions = {
      ...(this.options as {}),
      retryDelayMs: options.retryDelayMs,
      crudUploadThrottleMs: options.crudUploadThrottleMs,
      flags: this.resolvedFlags,
      adapter: this.bucketStorageAdapter,
      remote,
      uploadCrud: async () => {
        await this.waitForReady();
        await connector.uploadData(this);
      },
      identifier: this.database.name
    };

    switch (true) {
      case this.resolvedFlags.ssrMode:
        return new SSRStreamingSyncImplementation(syncOptions);
      case this.resolvedFlags.enableMultiTabs:
        if (!this.resolvedFlags.broadcastLogs) {
          const warning = `
            Multiple tabs are enabled, but broadcasting of logs is disabled.
            Logs for shared sync worker will only be available in the shared worker context
          `;
          const logger = this.options.logger;
          logger ? logger.warn(warning) : console.warn(warning);
        }
        return new SharedWebStreamingSyncImplementation({
          ...syncOptions,
          db: this.database as WebDBAdapter // This should always be the case
        });
      default:
        return new WebStreamingSyncImplementation(syncOptions);
    }
  }

  protected attachDevtoolsEventListeners() {
    // Wait for content script to load
    document.addEventListener('powersyncDevtoolsInit', (_event) => {
      // Devtools pane was opened, closed, and re-opened - needs data to be sent to it
      if (this.devtoolsAttached) {
        (async () => {
          const data = [];
          for (const table of this._schema.tables) {
            const tableData = await this.getAll(`SELECT * FROM ${table.name}`);
            data.push(tableData);
          }
          document.dispatchEvent(
            new CustomEvent('powersyncDevtoolsInitAck', {
              detail: {
                schema: this._schema,
                tables: data
              }
            })
          );
        })();

        return;
      }

      // Register listeners to tell devtools when internal structure / data changes
      this.registerListener({
        schemaChanged: (schema) =>
          document.dispatchEvent(
            new CustomEvent('powersyncSchemaChanged', {
              detail: {
                schema
              }
            })
          ),
        statusChanged: (status) =>
          document.dispatchEvent(
            new CustomEvent('powersyncStatusChanged', {
              detail: status
            })
          )
      });

      // Register listener for registering queries (runs after CS receives schema)
      document.addEventListener('powersyncDevtoolsRegisterQueries', (event: CustomEventInit<string[]>) => {
        if (!event.detail) {
          // TODO: More robust error handling, eg. request_ids for identifying sources of errors better
          document.dispatchEvent(
            new CustomEvent('powersyncDevtoolsError', {
              detail: {
                during: 'powersyncDevtoolsRegisterQueries',
                message: 'Missing event detail'
              }
            })
          );
          return;
        }

        // Register listener queries
        const tables = event.detail;
        for (const table of tables) {
          this.watchWithCallback(`SELECT * FROM ${table}`, [], {
            onResult: (result) => {
              document.dispatchEvent(
                new CustomEvent('powersyncTableChanged', {
                  detail: {
                    success: true,
                    data: {
                      tableName: table,
                      // Have to manually extract query results because results.rows.item is a
                      // function, and functions can only send JSON data (not functions).
                      //
                      // If Chrome finds a non-JSON object (eg. function signature) then
                      // the entire result object is set to null.
                      queryResult: {
                        insertId: result.insertId ?? undefined,
                        rows: result.rows
                          ? {
                              _array: result.rows?._array,
                              length: result.rows?.length
                            }
                          : undefined,
                        rowsAffected: result.rowsAffected
                      }
                    }
                  }
                })
              );
            },
            onError: (error) => {
              document.dispatchEvent(
                new CustomEvent('powersyncTableChanged', {
                  detail: {
                    success: false,
                    message: error.message
                  }
                })
              );
            }
          });
        }
      });

      // Register listener for requests for current table data
      document.addEventListener('powersyncDevtoolsSelectAll', async (event: CustomEventInit<{ tableName: string }>) => {
        this.getAll('SELECT * FROM ?', [event.detail!.tableName])
          .then((data) => {
            // Use TableChanged event handler because that already has the code for updating
            // the devtools' internal table representation
            document.dispatchEvent(
              new CustomEvent('powersyncTableChanged', {
                detail: {
                  success: true,
                  data
                }
              })
            );
          })
          .catch((error) =>
            document.dispatchEvent(
              new CustomEvent('powersyncTableChanged', {
                detail: {
                  success: false,
                  message: error.message
                }
              })
            )
          );
      });

      // Respond to devtools when done initializing
      this.registerListener({
        // Fetch all table schemas and table data before acknowledging
        initialized: async () => {
          // TODO: Consider converting this to an object with table names as keys
          const data = [];
          for (const table of this._schema.tables) {
            const tableData = await this.getAll(`SELECT * FROM ${table.name}`);
            data.push(tableData);
          }
          document.dispatchEvent(
            new CustomEvent('powersyncDevtoolsInitAck', {
              detail: {
                schema: this._schema,
                tables: data
              }
            })
          );
        }
      });
    });
  }
}
