import type { Namespace } from 'socket.io';
import { Adapter, SessionAwareAdapter } from 'socket.io-adapter';

/** Install in Server's constructor, before any namespace adapter is created.
 * Replacing an initialized SessionAwareAdapter would strand its private timer.
 * Other namespaces retain the server's existing connection recovery policy.
 */
export function petSocketAdapter(namespace: Namespace): Adapter {
    return namespace.name === '/desktop' || namespace.name === '/pet'
        ? new Adapter(namespace)
        : new SessionAwareAdapter(namespace);
}
