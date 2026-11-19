/// Keep only hexadecimal digits and insert a space between complete bytes.
export function normalizeHexInput(value: string): string {
  const digits = value.replace(/[^\da-f]/gi, "").toUpperCase();
  return digits.match(/.{1,2}/g)?.join(" ") ?? "";
}
