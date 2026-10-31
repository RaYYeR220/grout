// Shared types for the Box Office API. All times are stored as epoch milliseconds
// internally and rendered with new Date(ms).toISOString() in responses.

export type Role = "organizer" | "customer";

export interface User {
  id: string;
  email: string; // as registered (original case)
  emailLower: string; // lower-cased, used for uniqueness / login lookup
  passwordHash: string; // never returned
  name: string;
  role: Role;
}

/** User as returned by the API (no password). */
export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface Tier {
  id: string;
  name: string;
  priceCents: number;
  quantity: number;
}

export type EventStatus = "on_sale" | "cancelled";

export interface EventRecord {
  id: string;
  title: string;
  venue: string;
  startsAt: number; // epoch ms
  status: EventStatus;
  organizerId: string;
  tiers: Tier[];
  createdSeq: number;
}

export interface TierJson {
  id: string;
  name: string;
  priceCents: number;
  quantity: number;
  available: number;
}

export interface EventJson {
  id: string;
  title: string;
  venue: string;
  startsAt: string;
  status: EventStatus;
  organizerId: string;
  tiers: TierJson[];
}

export interface Discount {
  eventId: string;
  code: string; // stored upper case
  percentOff: number | null;
  amountOffCents: number | null;
  maxUses: number | null;
  expiresAt: number | null; // epoch ms
}

export interface DiscountJson {
  code: string;
  percentOff: number | null;
  amountOffCents: number | null;
  maxUses: number | null;
  expiresAt: string | null;
  uses: number;
}

export type OrderStatus = "held" | "paid" | "expired" | "cancelled" | "refunded";

export interface OrderItem {
  tierId: string;
  quantity: number;
  unitPriceCents: number;
}

export interface Order {
  id: string;
  eventId: string;
  customerId: string;
  status: OrderStatus;
  items: OrderItem[];
  subtotalCents: number;
  discountCode: string | null;
  discountCents: number;
  totalCents: number;
  createdAt: number; // epoch ms
  expiresAt: number; // epoch ms
  paidAt: number | null; // epoch ms
  createdSeq: number; // monotonically increasing, tie-breaker for "newest first"
}

export interface OrderJson {
  id: string;
  eventId: string;
  customerId: string;
  status: OrderStatus;
  items: OrderItem[];
  subtotalCents: number;
  discountCode: string | null;
  discountCents: number;
  totalCents: number;
  createdAt: string;
  expiresAt: string;
  paidAt: string | null;
}

export interface WaitlistEntry {
  id: string;
  eventId: string;
  tierId: string;
  customerId: string;
  quantity: number;
  createdSeq: number;
}

export interface WaitlistEntryJson {
  id: string;
  eventId: string;
  tierId: string;
  quantity: number;
  position: number;
}

export interface Store {
  users: Map<string, User>; // by id
  usersByEmail: Map<string, User>; // by lower-cased email
  sessions: Map<string, string>; // token -> userId
  events: Map<string, EventRecord>;
  orders: Map<string, Order>;
  discounts: Map<string, Map<string, Discount>>; // eventId -> UPPERCASE code -> Discount
  waitlist: WaitlistEntry[]; // in insertion order (createdSeq ascending)
  /** New globally unique id (unique across all entity kinds). */
  nextId(): string;
  /** Monotonic sequence number for ordering. */
  nextSeq(): number;
}

export interface Config {
  port: number;
  holdSeconds: number;
  /** Current time in epoch ms. Always use this instead of Date.now(). */
  now(): number;
}

export interface AppContext {
  store: Store;
  config: Config;
}

export interface Req {
  method: string; // upper case
  path: string; // pathname without query string
  params: Record<string, string>; // route params, e.g. { id }
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  /** Parsed JSON body; undefined when the request had no body. Invalid JSON is rejected with 400 before handlers run. */
  body: unknown;
}

export interface Res {
  status: number;
  body: unknown;
}

export type Handler = (ctx: AppContext, req: Req) => Res | Promise<Res>;

export interface Route {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path pattern with ":name" params, e.g. "/events/:id/cancel". */
  pattern: string;
  handler: Handler;
}

/** Throw this from anywhere; the HTTP layer renders { error: message } with the status. */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "HttpError";
  }
}

export const MAX_TICKETS_PER_EVENT = 6;
