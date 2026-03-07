import { Injectable } from '@angular/core';
import { io, Socket } from 'socket.io-client';

@Injectable({
  providedIn: 'root'
})
export class WebsocketService {
  private readonly sockets = new Map<string, Socket>();

  connect(namespace: string): Socket {
    const existing = this.sockets.get(namespace);
    if (existing) {
      return existing;
    }

    const socket = io(`${this.getBaseSocketUrl()}${namespace}`, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 800
    });

    this.sockets.set(namespace, socket);
    return socket;
  }

  connectMultipleNamespaces(namespaces: string[]): void {
    namespaces.forEach((namespace) => this.connect(namespace));
  }

  on<T>(namespace: string, event: string, callback: (payload: T) => void): () => void {
    const socket = this.connect(namespace);
    const listener = (payload: T) => callback(payload);
    socket.on(event, listener);

    return () => {
      socket.off(event, listener);
    };
  }

  disconnect(namespace: string): void {
    const socket = this.sockets.get(namespace);
    if (!socket) {
      return;
    }

    socket.disconnect();
    this.sockets.delete(namespace);
  }

  disconnectAll(): void {
    this.sockets.forEach((socket) => socket.disconnect());
    this.sockets.clear();
  }

  private getBaseSocketUrl(): string {
    return window.location.hostname === 'localhost'
      ? 'http://localhost:3000'
      : 'https://api.domdimabot.com';
  }
}
