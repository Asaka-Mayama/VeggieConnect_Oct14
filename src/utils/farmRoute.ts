import { useEffect, useState } from 'react';
import { Coordinates, DUMAGUETE_DEFAULT_COORDS, resolveCoordinates } from './geoDistance';
import { ProduceItem, UserProfile } from '../types';

// ---------------------------------------------------------------------------
// Supermarket hub (origin of every "route to the farmer's house" map).
// The admin pins this from Admin > Profile tab.
// ---------------------------------------------------------------------------
export const SUPERMARKET_STORAGE_KEY = 'veggieconnect_v9_clean_supermarket';
export const ADMIN_HUB_STORAGE_KEY = 'veggieconnect_v9_clean_admin_hub';

export interface SupermarketLocation {
  storeName: string;
  address: string;
  latitude: number;
  longitude: number;
}

export interface AdminLocationProfile {
  address?: string;
  latitude?: number;
  longitude?: number;
}

export const DEFAULT_SUPERMARKET: SupermarketLocation = {
  storeName: 'VeggieConnect Central Supermarket Hub',
  address: 'Dumaguete City Proper, Negros Oriental',
  latitude: DUMAGUETE_DEFAULT_COORDS.lat,
  longitude: DUMAGUETE_DEFAULT_COORDS.lng,
};

/**
 * Loads the saved supermarket location, merged on top of `seed`
 * (usually the admin account's own address/GPS pin).
 */
export function resolveSupermarketLocation(seed?: Partial<SupermarketLocation>): SupermarketLocation {
  const base: SupermarketLocation = { ...DEFAULT_SUPERMARKET, ...seed };
  try {
    const saved = localStorage.getItem(SUPERMARKET_STORAGE_KEY);
    if (saved) {
      return { ...base, ...(JSON.parse(saved) as Partial<SupermarketLocation>) };
    }
  } catch (e) {
    console.error('Failed to parse saved supermarket location', e);
  }
  return base;
}

export function loadSupermarketLocation(): SupermarketLocation {
  return resolveSupermarketLocation();
}

/**
 * Forces a re-render whenever the admin saves a live-route location, either in
 * this tab or through a cross-tab localStorage update.
 */
export function useAdminLocationSyncTick(): number {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const handleUpdate = () => setTick((current) => current + 1);

    window.addEventListener('veggieconnect:admin-location-updated', handleUpdate);
    return () => {
      window.removeEventListener('veggieconnect:admin-location-updated', handleUpdate);
    };
  }, []);

  return tick;
}

/**
 * Finds the signed-in admin's location data for live-route fallback resolution.
 * Farmers do not have an admin currentUser, so this checks the shared registry
 * first and then the persisted current-user record.
 */
export function getAdminProfileForLocationFallback(
  currentUser?: UserProfile | null,
  registeredUsers: UserProfile[] = []
): AdminLocationProfile | null {
  if (currentUser && currentUser.role === 'admin') {
    return {
      address: currentUser.location,
      ...(typeof currentUser.latitude === 'number'
        ? { latitude: currentUser.latitude }
        : {}),
      ...(typeof currentUser.longitude === 'number'
        ? { longitude: currentUser.longitude }
        : {}),
    };
  }

  // IMPORTANT: never fall back to the farmer's own currentUser. A farmer's
  // profile can contain a newer, resolved GPS pin that would otherwise make the
  // admin marker appear on the farm itself.
  const adminCandidates = registeredUsers.filter(
    (user) =>
      user.role === 'admin' &&
      (user.id === 'admin-main' || user.email?.trim().toLowerCase() === 'admin@gmail.com')
  );

  for (const registeredAdmin of adminCandidates) {
    const profile = toAdminLocationProfile(
      registeredAdmin.location,
      registeredAdmin.latitude,
      registeredAdmin.longitude
    );
    if (profile) return profile;
  }

  try {
    const savedUser = localStorage.getItem('veggieconnect_v9_clean_user');
    if (savedUser) {
      const parsed = JSON.parse(savedUser) as UserProfile | null;
      if (parsed && parsed.role === 'admin') {
        const profile = toAdminLocationProfile(parsed.location, parsed.latitude, parsed.longitude);
        if (profile) return profile;
      }
    }
  } catch (err) {
    console.error('Failed to read saved admin location', err);
  }

  // Last resort: the admin hub record stored separately from the signed-in
  // farmer session. It must never be interpreted as a farmer pin.
  return loadPersistedAdminHubProfile();
}

function toAdminLocationProfile(
  address?: string,
  latitude?: number,
  longitude?: number
): AdminLocationProfile | null {
  if (!address && typeof latitude !== 'number' && typeof longitude !== 'number') return null;
  return {
    ...(address ? { address } : {}),
    ...(typeof latitude === 'number' ? { latitude } : {}),
    ...(typeof longitude === 'number' ? { longitude } : {}),
  };
}

function loadPersistedAdminHubProfile(): AdminLocationProfile | null {
  try {
    const raw = localStorage.getItem(ADMIN_HUB_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AdminLocationProfile | null;
    if (!parsed) return null;
    return toAdminLocationProfile(parsed.address, parsed.latitude, parsed.longitude);
  } catch (err) {
    console.error('Failed to read persisted admin hub location', err);
    return null;
  }
}

function savePersistedAdminHubProfile(profile: AdminLocationProfile): void {
  try {
    const normalized = toAdminLocationProfile(
      profile.address,
      profile.latitude,
      profile.longitude
    );
    if (normalized) {
      localStorage.setItem(ADMIN_HUB_STORAGE_KEY, JSON.stringify(normalized));
    }
  } catch (err) {
    console.error('Failed to persist admin hub location', err);
  }
}

/**
 * Resolves the admin/supermarket endpoint shown on farmer live-transaction maps.
 *
 * The dedicated supermarket pin saved in Admin > Profile is authoritative because
 * it represents the store/admin logistics origin. It intentionally takes priority
 * over fallback coordinates derived from an admin account's textual address.
 */
export function resolveLiveTransactionAdminLocation(
  registeredUsers: UserProfile[] = [],
  adminProfile?: AdminLocationProfile | null
): SupermarketLocation {
  const savedSupermarket = resolveSupermarketLocation();
  const savedHasCustomPin =
    savedSupermarket.latitude !== DEFAULT_SUPERMARKET.latitude ||
    savedSupermarket.longitude !== DEFAULT_SUPERMARKET.longitude;

  // The dedicated admin hub is authoritative whenever it has a real pin. It is
  // stored separately from the farmer session so the marker can never inherit
  // the signed-in farmer's coordinates.
  const persistedHub = loadPersistedAdminHubProfile();
  const persistedHubPin = persistedHub && toGpsPin(persistedHub.latitude, persistedHub.longitude);
  if (persistedHubPin) {
    return {
      ...savedSupermarket,
      ...(persistedHub.address ? { address: persistedHub.address } : {}),
      latitude: persistedHubPin.lat,
      longitude: persistedHubPin.lng,
    };
  }

  // Backfill/migrate the dedicated record from an existing saved admin pin so
  // every later render uses the same authoritative source.
  if (savedHasCustomPin) {
    savePersistedAdminHubProfile({
      address: savedSupermarket.address,
      latitude: savedSupermarket.latitude,
      longitude: savedSupermarket.longitude,
    });
    return savedSupermarket;
  }

  // No dedicated store pin has been saved yet: fall back to the admin's own
  // GPS/address so the marker is not left at the generic Dumaguete default.
  const adminAccount = adminProfile || getAdminProfileForLocationFallback(null, registeredUsers);
  if (!adminAccount) {
    return savedSupermarket;
  }

  const adminPin = toGpsPin(adminAccount.latitude, adminAccount.longitude);
  if (adminPin) {
    return {
      ...savedSupermarket,
      address: adminAccount.address || savedSupermarket.address,
      latitude: adminPin.lat,
      longitude: adminPin.lng,
    };
  }

  if (adminAccount.address) {
    const resolved = resolveCoordinates(
      adminAccount.address,
      adminAccount.latitude,
      adminAccount.longitude
    );
    return {
      ...savedSupermarket,
      address: adminAccount.address,
      latitude: resolved.lat,
      longitude: resolved.lng,
    };
  }

  return savedSupermarket;
}

// Origin point of the live route map
export function getSupermarketHubCoords(registeredUsers?: UserProfile[]): Coordinates {
  const hub = resolveLiveTransactionAdminLocation(registeredUsers);
  return { lat: hub.latitude, lng: hub.longitude };
}

// ---------------------------------------------------------------------------
// Farmer house coordinate resolution
// ---------------------------------------------------------------------------
export interface FarmHouseLookup {
  /**
   * Direct GPS pin (highest priority). Pass only when it belongs to THIS
   * transaction — never seed it with the viewer's unrelated account coordinates.
   */
  latitude?: number;
  longitude?: number;
  farmerId?: string;
  farmName?: string;
  farmerName?: string;
  /** Textual pickup / farm address used as the last resort. */
  locationText?: string;
  registeredUsers?: UserProfile[];
  produceList?: ProduceItem[];
  /**
   * Optional item-level identities for orders containing produce from multiple
   * farmers. These are checked before the order-level farmer identity so the
   * route points at the actual farm supplying this transaction.
   */
  itemFarmerId?: string;
  itemFarmerName?: string;
  itemFarmName?: string;
}

export interface FarmHouse {
  coords: Coordinates;
  label: string;
  address: string;
  source: 'pin' | 'account' | 'produce' | 'location';
}

/** Returns GPS coordinates only when the pair is inside Negros Oriental bounds. */
function toGpsPin(lat?: number, lng?: number): Coordinates | null {
  if (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    !isNaN(lat) &&
    !isNaN(lng) &&
    lat >= 8.0 &&
    lat <= 12.0 &&
    lng >= 121.0 &&
    lng <= 125.0
  ) {
    return { lat, lng };
  }
  return null;
}

/**
 * Resolves the GPS coordinates of the farmer's house for a live transaction.
 * Priority: explicit pin > registered farmer account > produce listing > text address.
 */
export function resolveFarmHouseCoordinates(lookup: FarmHouseLookup): FarmHouse {
  const {
    latitude,
    longitude,
    farmerId,
    farmName,
    farmerName,
    locationText,
    registeredUsers = [],
    produceList = [],
    itemFarmerId,
    itemFarmerName,
    itemFarmName,
  } = lookup;

  // The supplying item identifies the farm more precisely than order-level
  // metadata, which can be absent or belong to a different party.
  const effectiveFarmerId = itemFarmerId || farmerId;
  const effectiveFarmName = itemFarmName || farmName;
  const effectiveFarmerName = itemFarmerName || farmerName;

  const normalizedFarm = effectiveFarmName?.trim().toLowerCase();
  const normalizedFarmer = effectiveFarmerName?.trim().toLowerCase();

  // 1. Exact GPS pin handed in by the caller
  const requestedPin = toGpsPin(latitude, longitude);
  if (requestedPin) {
    return {
      coords: requestedPin,
      label: effectiveFarmName || effectiveFarmerName || 'Farmer House',
      address: locationText || '',
      source: 'pin',
    };
  }

  // 2. Registered farmer account (its pinned house / farm location)
  const account = registeredUsers.find(
    (u) =>
      (effectiveFarmerId && u.id === effectiveFarmerId) ||
      (normalizedFarm && u.farmName && u.farmName.trim().toLowerCase() === normalizedFarm) ||
      (normalizedFarmer && u.name && u.name.trim().toLowerCase() === normalizedFarmer)
  );
  const accountPin = account ? toGpsPin(account.latitude, account.longitude) : null;
  if (account && accountPin) {
    return {
      coords: accountPin,
      label: account.farmName || account.name || effectiveFarmName || 'Farmer House',
      address: account.location,
      source: 'account',
    };
  }

  // 3. Produce listing carried its own farm GPS pin
  const produce = produceList.find(
    (p) =>
      (effectiveFarmerId && p.farmerId === effectiveFarmerId) ||
      (normalizedFarm && p.farmName && p.farmName.trim().toLowerCase() === normalizedFarm) ||
      (normalizedFarmer && p.farmerName && p.farmerName.trim().toLowerCase() === normalizedFarmer)
  );
  const producePin = produce ? toGpsPin(produce.latitude, produce.longitude) : null;
  if (produce && producePin) {
    return {
      coords: producePin,
      label: produce.farmName || effectiveFarmName || 'Farmer House',
      address: produce.location,
      source: 'produce',
    };
  }

  // 4. Last resort: geocode the textual address
  const address = locationText || account?.location || produce?.location || '';
  return {
    coords: resolveCoordinates(address),
    label: effectiveFarmName || effectiveFarmerName || account?.farmName || produce?.farmName || 'Farmer House',
    address,
    source: 'location',
  };
}
