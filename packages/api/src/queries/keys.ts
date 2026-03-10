// ============================================================
// TriciGo — TanStack Query Key Factory
// Centralized query keys for cache management and invalidation.
// Pattern: entity → list/detail → params
// ============================================================

export const queryKeys = {
  // Auth & Users
  auth: {
    session: ['auth', 'session'] as const,
    user: (userId: string) => ['auth', 'user', userId] as const,
  },

  // Customer profiles
  customer: {
    profile: (userId: string) => ['customer', 'profile', userId] as const,
    savedLocations: (userId: string) =>
      ['customer', 'savedLocations', userId] as const,
  },

  // Driver profiles
  driver: {
    profile: (userId: string) => ['driver', 'profile', userId] as const,
    documents: (driverId: string) =>
      ['driver', 'documents', driverId] as const,
    status: (driverId: string) => ['driver', 'status', driverId] as const,
    list: (filters?: Record<string, unknown>) =>
      ['driver', 'list', filters] as const,
  },

  // Vehicles
  vehicle: {
    byDriver: (driverId: string) => ['vehicle', 'byDriver', driverId] as const,
    detail: (vehicleId: string) => ['vehicle', 'detail', vehicleId] as const,
  },

  // Wallet & Ledger
  wallet: {
    account: (userId: string) => ['wallet', 'account', userId] as const,
    summary: (userId: string) => ['wallet', 'summary', userId] as const,
    transactions: (accountId: string, page?: number) =>
      ['wallet', 'transactions', accountId, page] as const,
    redemptions: (driverId: string) =>
      ['wallet', 'redemptions', driverId] as const,
  },

  // Rides
  ride: {
    detail: (rideId: string) => ['ride', 'detail', rideId] as const,
    active: (userId: string) => ['ride', 'active', userId] as const,
    history: (userId: string, page?: number) =>
      ['ride', 'history', userId, page] as const,
    transitions: (rideId: string) =>
      ['ride', 'transitions', rideId] as const,
    pricing: (rideId: string) => ['ride', 'pricing', rideId] as const,
  },

  // Reviews
  review: {
    byRide: (rideId: string) => ['review', 'byRide', rideId] as const,
    byUser: (userId: string) => ['review', 'byUser', userId] as const,
    summary: (userId: string) => ['review', 'summary', userId] as const,
  },

  // Service types & pricing
  services: {
    types: ['services', 'types'] as const,
    pricing: (zoneId?: string) => ['services', 'pricing', zoneId] as const,
    zones: ['services', 'zones'] as const,
  },

  // Promotions
  promotion: {
    active: ['promotion', 'active'] as const,
    validate: (code: string) => ['promotion', 'validate', code] as const,
  },

  // Chat
  chat: {
    messages: (rideId: string) => ['chat', 'messages', rideId] as const,
  },

  // Admin
  admin: {
    dashboard: ['admin', 'dashboard'] as const,
    auditLog: (page?: number) => ['admin', 'auditLog', page] as const,
    pendingDrivers: ['admin', 'pendingDrivers'] as const,
    activeRides: ['admin', 'activeRides'] as const,
  },
} as const;
