/** Touch-first devices, not small desktop windows or mouse-first touch laptops. */
export function touchPrimary(): boolean {
  return typeof window !== "undefined" &&
    window.matchMedia("(pointer: coarse) and (hover: none)").matches;
}
