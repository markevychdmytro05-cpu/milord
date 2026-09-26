export type CabinetSection = 'orders' | 'wishlist' | 'cart';
export interface CabinetProduct {
  id: string;
  name: string;
  quantity: number | null;
  price: number | null;
  total: number | null;
  url?: string;
  reservedUntil?: string;
}
export interface CabinetOrder {
  id: string;
  // Combined orders can display a number different from their detail URL.
  detailId?: string;
  mergedInto?: string;
  date: string;
  status: string;
  total: number | null;
  quantity: number | null;
  tracking: string;
}
export interface CabinetOrderDetails {
  id: string;
  delivery: string;
  deliveryCost: string;
  address: string;
  payment: string;
  total: number | null;
  products: CabinetProduct[];
  history: { at: string; status: string }[];
}
export interface CabinetSnapshot {
  profileId: string;
  fetchedAt: number;
  orders?: CabinetOrder[];
  orderPages?: Record<string, CabinetOrder[]>;
  wishlist?: CabinetProduct[];
  cart?: CabinetProduct[];
  errors: Partial<Record<CabinetSection, string>>;
  nextOrdersPage?: number;
}

export interface CabinetOrdersPage {
  profileId: string;
  page: number;
  orders: CabinetOrder[];
  nextPage?: number;
  fetchedAt: number;
}
