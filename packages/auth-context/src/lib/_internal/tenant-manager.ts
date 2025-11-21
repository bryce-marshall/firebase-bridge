import {
  CreateRequest,
  UpdateRequest,
  UserImportRecord,
  UserRecord,
} from 'firebase-admin/auth';
import { AltKey, AuthKey } from '../types.js';
import {
  authError,
  identityError,
  uidExistsError,
  userNotFoundError,
} from './auth-error.js';
import {
  assignMultiFactors,
  base64PasswordHash,
  base64PasswordSalt,
  isValidUid,
  toUserRecord,
  validatedCustomClaims,
} from './auth-helpers.js';
import { AuthInstance, PersistedUserInfo } from './auth-types.js';
import {
  assignIf,
  assignIfOrDeleteNull,
  cloneDeep,
  millisToSeconds,
  rejectPromise,
  resolvePromise,
  userId,
} from './util.js';

/**
 * Predicate used to filter {@link AuthInstance} entries in the internal user store.
 */
export type AuthInstancePredicate = (ai: AuthInstance) => boolean;

/**
 * Manages an in-memory collection of {@link AuthInstance} objects across tenants.
 *
 * @remarks
 * This class provides the backing store for a mock implementation of
 * `firebase-admin/auth` user-management APIs. It tracks default identities
 * (registered by key), active users, and per-tenant state, and enforces
 * constraints such as UID, email, and phone-number uniqueness.
 *
 * The manager is multi-tenant aware and supports both global (no tenant)
 * and tenant-scoped identities, closely mirroring Firebase Authentication
 * and Identity Platform semantics sufficiently for unit tests.
 *
 * @typeParam TKey - Application-specific key type used to register default identities.
 */
export class TenantManager<TKey extends AuthKey> {
  private _defaults = new Map<TKey, AuthInstance>();
  private _global = new Map<string, AuthInstance>();
  private _tenants = new Map<string, Map<string, AuthInstance>>();
  private _tenantScoped = new Map<string, Map<string, unknown>>();

  /**
   * Creates a new tenant manager.
   *
   * @param now - A time provider returning the current time in milliseconds
   * since the Unix epoch. Used for metadata fields such as `creationTime`
   * and `lastSignInTime`.
   */
  constructor(readonly now: () => number) {}

  /**
   * Gets the current time according to the configured {@link now} generator,
   * expressed as seconds since the Unix epoch.
   */
  epoch(): number {
    return millisToSeconds(this.now());
  }

  /**
   * Gets the current time according to the configured {@link now} generator,
   * formatted as an ISO-8601 string.
   */
  isoNow(): string {
    return new Date(this.now()).toISOString();
  }

  /**
   * Resets all active state to match the registered default identities.
   *
   * @remarks
   * - Clears the global, tenant, and tenant-scoped stores.
   * - Re-clones each default {@link AuthInstance} into the active stores.
   * - Useful for restoring a known baseline between unit tests.
   */
  reset(): void {
    this._global.clear();
    this._tenants.clear();
    this._tenantScoped.clear();

    for (const ai of this._defaults.values()) {
      const uid = ai.uid;
      const active = cloneDeep(ai);
      this._global.set(uid, active);
      this.getTenantStore(active.tenantId).set(uid, active);
    }
  }

  /**
   * Creates a new user in the specified tenant.
   *
   * @remarks
   * - Generates a UID if one is not supplied in {@link CreateRequest.uid}.
   * - Validates UID format and uniqueness.
   * - Applies the supplied properties, including password if present.
   *
   * @param tenantId - Target tenant identifier, or `null`/`undefined` for the
   * default (unscoped) tenant.
   * @param properties - User properties matching `CreateRequest` from
   * `firebase-admin/auth`.
   * @returns A promise that resolves with the created {@link UserRecord}.
   */
  create(
    tenantId: string | null | undefined,
    properties: CreateRequest
  ): Promise<UserRecord> {
    const uid = properties.uid ?? userId();

    try {
      const ai = this.initInstance(tenantId, uid);
      this.assignUpdateRequest(ai, properties);
      this._global.set(uid, ai);
      this.getTenantStore(tenantId).set(uid, ai);

      return resolvePromise(toUserRecord(ai));
    } catch (e) {
      return rejectPromise(e);
    }
  }

  /**
   * Updates an existing user in the specified tenant.
   *
   * @remarks
   * - Applies `UpdateRequest` semantics, including email/phone uniqueness
   *   checks within the tenant.
   * - Updates password hash/salt if `password` is provided.
   *
   * @param tenantId - Target tenant identifier, or `null`/`undefined` for the
   * default (unscoped) tenant.
   * @param uid - UID of the user to update.
   * @param properties - Properties to update, matching `UpdateRequest` from
   * `firebase-admin/auth`.
   * @returns A promise that resolves with the updated {@link UserRecord},
   * or rejects if the user does not exist.
   */
  update(
    tenantId: string | null | undefined,
    uid: string,
    properties: UpdateRequest
  ): Promise<UserRecord> {
    const ai = this.tryGet(tenantId, uid);
    if (!ai) return rejectPromise(userNotFoundError({ uid }));

    try {
      this.assignUpdateRequest(ai, properties);

      return resolvePromise(toUserRecord(ai));
    } catch (e) {
      return rejectPromise(e);
    }
  }

  /**
   * Imports a user into the specified tenant without returning a {@link UserRecord}.
   *
   * @remarks
   * - Used to seed the in-memory store from {@link UserImportRecord} data.
   * - Applies metadata, custom claims, password hash/salt, multi-factor
   *   enrollment, and provider data.
   * - Overwrites any existing user with the same UID.
   *
   * @param tenantId - Target tenant identifier, or `null`/`undefined` for the
   * default (unscoped) tenant.
   * @param user - User data to import.
   */
  import(tenantId: string | null | undefined, user: UserImportRecord): void {
    const ai = this.initInstance(tenantId, user.uid);
    this.assignUpdateRequest(ai, user);

    if (user.customClaims) {
      ai.claims = validatedCustomClaims(user.customClaims);
    }

    if (user.metadata) {
      assignIf(ai.metadata, 'creationTime', user.metadata.creationTime);
      assignIf(ai.metadata, 'lastSignInTime', user.metadata.lastSignInTime);
    }

    if (user.passwordHash) {
      ai.passwordHash = user.passwordHash.toString('base64');

      if (user.passwordSalt) {
        ai.passwordSalt = user.passwordSalt.toString('base64');
      }
    }

    assignMultiFactors(ai, user.multiFactor?.enrolledFactors);

    if (user.providerData?.length) {
      for (const pd of user.providerData) {
        if (!pd) continue;

        const ui: PersistedUserInfo = {
          uid: pd.uid,
          providerId: pd.providerId,
        };
        assignIf(ui, 'displayName', pd.displayName);
        assignIf(ui, 'email', pd.email);
        assignIf(ui, 'phoneNumber', pd.phoneNumber);
        assignIf(ui, 'photoURL', pd.photoURL);
        ai.userInfo[ui.providerId] = ui;
      }
    }

    this._global.set(ai.uid, ai);
    this.getTenantStore(tenantId).set(ai.uid, ai);
  }

  /**
   * Deletes a user from the specified tenant.
   *
   * @param tenantId - Target tenant identifier, or `null`/`undefined` for the
   * default (unscoped) tenant.
   * @param uid - UID of the user to delete.
   * @returns `true` if the user existed and was deleted; otherwise, `false`.
   */
  delete(tenantId: string | null | undefined, uid: string): boolean {
    const store = this.getTenantStore(tenantId);
    if (!store.delete(uid)) return false;
    this._global.delete(uid);

    return true;
  }

  /**
   * Registers a default identity under the specified key.
   *
   * @remarks
   * - Fails if the key has already been registered.
   * - Fails if a user with the same UID already exists in the global store.
   * - Validates and normalizes custom claims.
   * - The registered {@link AuthInstance} is treated as a template; a cloned,
   *   mutable copy is stored as the active instance.
   *
   * @param key - Application-defined key identifying the default identity.
   * @param ai - Auth instance to register as the default for the given key.
   */
  register(key: TKey, ai: AuthInstance): void {
    if (this._defaults.has(key))
      throw identityError(key, 'operation-not-allowed', 'Already registered');

    if (this._global.has(ai.uid)) throw uidExistsError(ai.uid);

    if (ai.claims) {
      ai.claims = validatedCustomClaims(ai.claims);
    }

    this._defaults.set(key, ai);
    // Clone the active instance because it is mutable
    const active = cloneDeep(ai);
    this._global.set(ai.uid, active);
    this.getTenantStore(ai.tenantId).set(ai.uid, active);
  }

  /**
   * Deregisters a default identity previously registered with {@link register}.
   *
   * @param key - Key identifying the default identity.
   * @returns `true` if the identity was found and deregistered; otherwise, `false`.
   */
  deregister(key: TKey): boolean {
    const ai = this._defaults.get(key);
    if (!ai) return false;

    this._defaults.delete(key);
    this._global.delete(ai.uid);
    this.getTenantStore(ai.tenantId).delete(ai.uid);

    return true;
  }

  /**
   * Attempts to retrieve an active {@link AuthInstance} by UID within
   * the specified tenant.
   *
   * @param tenantId - Target tenant identifier, or `null`/`undefined` for the
   * default (unscoped) tenant.
   * @param uid - UID of the user to retrieve.
   * @returns The matching {@link AuthInstance}, or `undefined` if not found.
   */
  tryGet(
    tenantId: string | null | undefined,
    uid: string
  ): AuthInstance | undefined {
    return this.getTenantStore(tenantId).get(uid);
  }

  /**
   * Searches for the first {@link AuthInstance} in the specified tenant
   * that matches the given predicate.
   *
   * @param tenantId - Target tenant identifier, or `null`/`undefined` for the
   * default (unscoped) tenant.
   * @param predicate - Predicate applied to each {@link AuthInstance}.
   * @returns The first matching instance, or `undefined` if none match.
   */
  find(
    tenantId: string | null | undefined,
    predicate: AuthInstancePredicate
  ): AuthInstance | undefined {
    for (const ai of this.getTenantStore(tenantId).values()) {
      if (predicate(ai)) return ai;
    }

    return undefined;
  }

  /**
   * Gets all active {@link AuthInstance} objects for the specified tenant.
   *
   * @param tenantId - Target tenant identifier, or `null`/`undefined` for the
   * default (unscoped) tenant.
   * @returns An array containing all active instances for the tenant.
   */
  all(tenantId: string | null | undefined): AuthInstance[] {
    return Array.from(this.getTenantStore(tenantId).values());
  }

  /**
   * Resolves the active {@link AuthInstance} associated with a registered key.
   *
   * @remarks
   * - Uses the UID from the default identity stored under the given key.
   * - Throws if the key is not registered or the active instance has been deleted.
   *
   * @param key - Registered identity key.
   * @returns The active {@link AuthInstance} corresponding to the registered key.
   * @throws {@link Error} if the key is not registered or the instance is missing.
   */
  getByKey(key: TKey | AltKey): AuthInstance {
    let ai: AuthInstance | undefined;
    if (key instanceof AltKey) {
      if (!key.value) {
        throw identityError(
          key,
          'invalid-argument',
          `AltKey has missing or invalid ${key.type}.`
        );
      }

      let p: AuthInstancePredicate;
      switch (key.type) {
        case 'email':
          p = (ai) => ai.email === key.value;
          break;

        case 'phone':
          p = (ai) => ai.phoneNumber === key.value;
          break;

        case 'uid':
          p = (ai) => ai.uid === key.value;
          break;

        default:
          throw identityError(
            key,
            'invalid-argument',
            `Unrecognised AltKey type "${key.type}".`
          );
      }
      ai = this.find(key.tenantId, p);
    } else {
      const uid = this._defaults.get(key)?.uid;

      if (uid == undefined)
        throw identityError(
          key,
          'user-not-found',
          'Not registered with AuthManager'
        );

      ai = this._global.get(uid);
    }

    if (ai == undefined)
      throw identityError(key, 'user-not-found', 'User not found');

    return ai;
  }

  /**
   * Determines whether a user with the given UID exists in the global store,
   * regardless of tenant.
   *
   * @param uid - UID to check.
   * @returns `true` if the UID exists; otherwise, `false`.
   */
  uidExists(uid: string): boolean {
    return this._global.has(uid);
  }

  /**
   * Determines whether an email address is already in use by another user
   * within the specified tenant.
   *
   * @remarks
   * - The check ignores the user identified by {@link uid}.
   * - Used to emulate `email-already-exists` errors.
   *
   * @param tenantId - Target tenant identifier, or `null`/`undefined` for the
   * default (unscoped) tenant.
   * @param uid - UID of the user being created/updated (to be excluded).
   * @param email - Email address to check.
   * @returns `true` if a different user already has this email; otherwise, `false`.
   */
  emailExists(
    tenantId: string | null | undefined,
    uid: string,
    email: string
  ): boolean {
    if (!email) return false;

    return (
      this.find(
        tenantId,
        (ai) => ai.uid != uid && ai.email != undefined && ai.email === email
      ) != undefined
    );
  }

  /**
   * Determines whether a phone number is already in use by another user
   * within the specified tenant.
   *
   * @remarks
   * - The check ignores the user identified by {@link uid}.
   * - Used to emulate `phone-number-already-exists` errors.
   *
   * @param tenantId - Target tenant identifier, or `null`/`undefined` for the
   * default (unscoped) tenant.
   * @param uid - UID of the user being created/updated (to be excluded).
   * @param phoneNumber - Phone number to check.
   * @returns `true` if a different user already has this phone number; otherwise, `false`.
   */
  phoneExists(
    tenantId: string | null | undefined,
    uid: string,
    phoneNumber: string
  ): boolean {
    if (!phoneNumber) return false;

    return (
      this.find(
        tenantId,
        (ai) =>
          ai.uid != uid &&
          ai.phoneNumber != undefined &&
          ai.phoneNumber === phoneNumber
      ) != undefined
    );
  }

  /**
   * Retrieves or lazily creates a tenant-scoped singleton value.
   *
   * @remarks
   * This is a generic cache that can be used by higher-level mocks to store
   * arbitrary per-tenant resources (for example, statistics or auxiliary
   * state). The value is created with {@link factory} on first access and
   * reused for subsequent calls.
   *
   * @typeParam T - Type of the cached value.
   * @param tenantId - Target tenant identifier, or `null`/`undefined` for the
   * default (unscoped) tenant.
   * @param key - Cache key within the tenant scope.
   * @param factory - Factory invoked to create the value when it does not exist.
   * @returns The existing or newly created value.
   */
  tenantScoped<T>(
    tenantId: string | null | undefined,
    key: string,
    factory: () => T
  ): T {
    const store = ensureStore(tenantId, this._tenantScoped);
    let v = store.get(key) as T;
    if (v == undefined) {
      v = factory();
      store.set(key, v);
    }

    return v;
  }

  /**
   * Gets the tenant-specific user store, creating it on first use.
   *
   * @param tenantId - Tenant identifier or `null`/`undefined` for the default tenant.
   * @returns A mutable map of UID to {@link AuthInstance} for the tenant.
   */
  private getTenantStore(
    tenantId: string | null | undefined
  ): Map<string, AuthInstance> {
    return ensureStore(tenantId, this._tenants);
  }

  /**
   * Initializes a new {@link AuthInstance} for the given tenant and UID.
   *
   * @remarks
   * - Validates UID presence, format, and uniqueness.
   * - Initializes metadata timestamps using the configured {@link now} generator.
   *
   * @param tenantId - Tenant identifier or `null`/`undefined` for the default tenant.
   * @param uid - UID of the user being created.
   * @returns A newly constructed {@link AuthInstance}.
   * @throws {@link Error} if the UID is missing, invalid, or already exists.
   */
  private initInstance(
    tenantId: string | null | undefined,
    uid: string
  ): AuthInstance {
    if (!uid) throw authError('missing-uid');
    if (!isValidUid(uid)) {
      throw authError('invalid-uid');
    }
    if (this.uidExists(uid)) {
      throw uidExistsError(uid);
    }

    const nowIso = new Date(this.now()).toISOString();

    const ai: AuthInstance = {
      uid,
      disabled: false,
      userInfo: {},
      metadata: {
        creationTime: nowIso,
        lastSignInTime: nowIso,
      },
    };

    assignIf(ai, 'tenantId', tenantId);

    return ai;
  }

  /**
   * Applies an `UpdateRequest`-style payload to an {@link AuthInstance}.
   *
   * @remarks
   * - Enforces email and phone-number uniqueness within the tenant.
   * - Assigns email, phone number, display name, photo URL, disabled flags
   *   and password-related fields.
   *
   * @param ai - Target auth instance to mutate.
   * @param properties - User properties to assign.
   * @throws {@link Error} if email or phone-number conflicts are detected.
   */
  private assignUpdateRequest(
    ai: AuthInstance,
    properties: UpdateRequest
  ): void {
    const uid = ai.uid;
    if (
      properties.email &&
      this.emailExists(ai.tenantId, uid, properties.email)
    ) {
      throw authError('email-already-exists');
    }

    if (
      properties.phoneNumber &&
      this.phoneExists(ai.tenantId, uid, properties.phoneNumber)
    ) {
      throw authError('phone-number-already-exists');
    }

    assignIf(ai, 'emailVerified', properties.emailVerified);
    assignIfOrDeleteNull(ai, 'email', properties.email);
    assignIfOrDeleteNull(ai, 'phoneNumber', properties.phoneNumber);
    assignIfOrDeleteNull(ai, 'displayName', properties.displayName);
    assignIfOrDeleteNull(ai, 'photoURL', properties.photoURL);
    assignIf(ai, 'disabled', properties.disabled);

    if (properties.password !== undefined) {
      ai.passwordHash = base64PasswordHash(properties.password);
      ai.passwordSalt = base64PasswordSalt();
    }
  }
}

/**
 * Ensures that a tenant- or global-scoped store exists within the given container.
 *
 * @remarks
 * - `null` or `undefined` tenant identifiers are normalized to the empty string.
 * - If the store does not exist, a new `Map` is created and registered.
 *
 * @typeParam T - Type of values stored in the nested map.
 * @param key - Tenant identifier key (or `null`/`undefined` for the default scope).
 * @param container - Container mapping tenant keys to stores.
 * @returns The existing or newly created store for the given key.
 */
function ensureStore<T>(
  key: string | null | undefined,
  container: Map<string, Map<string, T>>
): Map<string, T> {
  const k = key ?? '';
  let store = container.get(k);
  if (store == undefined) {
    store = new Map();
    container.set(k, store);
  }

  return store;
}
