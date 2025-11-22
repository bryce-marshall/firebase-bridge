import { AuthProvider } from '../../_internal/types.js';
import { AuthKey } from '../../types.js';
import { HttpsBroker } from '../https-types.js';
import { HttpsV1Handler } from '../v1-types.js';
import { HttpsV2Handler } from '../v2-types.js';
import { _HttpsV1Handler } from './https-v1-handler.js';
import { _HttpsV2Handler } from './https-v2-handler.js';

export class _HttpsBroker<TKey extends AuthKey> implements HttpsBroker<TKey> {
  readonly v1: HttpsV1Handler<TKey>;
  readonly v2: HttpsV2Handler<TKey>;

  /**
   * Create a new {@link HttpsBroker}.
   *
   * @param provider - An {@link AuthProvider} that supplies identities and contexts for requests.
   *
   * @remarks
   * The broker wires the same provider into both {@link v1} and {@link v2} handlers to ensure
   * consistent identity and App Check behavior across API versions.
   */
  constructor(provider: AuthProvider<TKey>) {
    this.v1 = new _HttpsV1Handler(provider);
    this.v2 = new _HttpsV2Handler(provider);
  }
}
