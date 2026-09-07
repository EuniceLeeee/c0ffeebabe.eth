import { ethers } from "ethers";

// Address syntax/checksum is a pure property of the original string, not chain
// state. Bound the process-local memo; failures and coerced values never enter.
const checkedAddresses = new Map<string, string>();
const MAX_CHECKED_ADDRESSES = 4096;

export function cachedCanonicalAddress(value: string): string {
  if (typeof value !== "string") return ethers.getAddress(value);
  const cached = checkedAddresses.get(value);
  if (cached !== undefined) return cached;
  const checked = ethers.getAddress(value);
  if (checkedAddresses.size >= MAX_CHECKED_ADDRESSES) {
    checkedAddresses.delete(checkedAddresses.keys().next().value!);
  }
  // Never normalize the key before checking: invalid mixed-case input must
  // not borrow the validation of a valid lowercase representation.
  checkedAddresses.set(value, checked);
  return checked;
}
