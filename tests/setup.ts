import "@testing-library/jest-dom";

// jsdom doesn't implement these — needed for Radix UI's `Select` (used by
// `RoleAssignmentPanel`'s "Add role" dropdown, um12-spec §12.10) to handle
// pointer events under user-event's click simulation. Guarded on `Element`
// existing at all since this setup file also runs ahead of DB-free unit
// test files that use Vitest's default `node` environment (no DOM global).
if (typeof Element !== "undefined") {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
}

// jsdom doesn't implement `ResizeObserver` — needed for Radix UI's
// `Checkbox` (its size-measuring indicator, `@radix-ui/react-use-size`) to
// mount at all. pm19 (`OfferingForm`'s Sellable/Billing only checkboxes) is
// the first test suite to actually render a `Checkbox` with a non-empty
// parent (every prior usage, e.g. `UserForm`'s role list, was only exercised
// in tests with an empty list, so this gap went undetected until now).
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}
