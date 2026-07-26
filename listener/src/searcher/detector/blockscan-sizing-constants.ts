/**
 * The coarse scanner sizes a venue to one quarter of its input-side depth and
 * rejects ceilings below nine raw units. Pricing families use the same values
 * when deciding whether integer reserve proxies retain executable precision.
 */
export const BLOCKSCAN_VENUE_DEPTH_DIVISOR = 4n;
export const BLOCKSCAN_MIN_EXECUTABLE_INPUT = 9n;
export const BLOCKSCAN_MIN_VENUE_RESERVE_IN =
  BLOCKSCAN_MIN_EXECUTABLE_INPUT * BLOCKSCAN_VENUE_DEPTH_DIVISOR;
