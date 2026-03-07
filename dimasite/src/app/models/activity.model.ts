export interface ActivityCounters {
  follows: number;
  subs: number;
  bits: number;
  donations: number;
  messages: number;
  commands: number;
}

export interface ActivityUpdate {
  type: 'follow' | 'sub' | 'bits' | 'donation' | 'message' | 'command';
  timestamp: string;
}
