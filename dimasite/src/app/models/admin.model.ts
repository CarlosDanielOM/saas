export interface ApiEnvelope<T> {
  error: boolean;
  message?: string;
  status?: number;
  data?: T;
}

export interface AdminRecord {
  _id?: string;
  adminName: string;
  adminID: string;
  channelName: string;
  channelID: string;
  actived: boolean;
  permissions: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface AdminCandidate {
  id: string;
  login: string;
  display_name: string;
}

export interface AdminListResponse {
  error: boolean;
  message?: string;
  status?: number;
  data?: AdminRecord[];
  pagination?: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
