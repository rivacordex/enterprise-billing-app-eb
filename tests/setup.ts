import "@testing-library/jest-dom";

// jsdom doesn't implement these — needed for Radix UI's `Select` (used by
// `RoleAssignmentPanel`'s "Add role" dropdown, um12-spec §12.10) to handle
// pointer events under user-event's click simulation.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
