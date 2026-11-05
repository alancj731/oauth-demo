import { randomBytes } from "node:crypto";

/** URL-safe random string (`bytes` of entropy). */
export const randomId = (bytes = 16) => randomBytes(bytes).toString("base64url");

/** Escape text for HTML. */
export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export class Raw {
  constructor(public readonly value: string) {}
  toString() {
    return this.value;
  }
}
export const raw = (s: string) => new Raw(s);

function render(v: unknown): string {
  if (v === null || v === undefined || v === false) return "";
  if (v instanceof Raw) return v.value;
  if (Array.isArray(v)) return v.map(render).join("");
  return esc(String(v));
}

/** Tagged template that escapes every interpolation unless it is `raw()` / nested `html`. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = strings[0];
  values.forEach((v, i) => (out += render(v) + strings[i + 1]));
  return new Raw(out);
}

/** JSON safe to embed inside a <script type="application/json"> tag. */
export const jsonForScript = (v: unknown) => raw(JSON.stringify(v).replace(/</g, "\\u003c"));

export const b64url = (buf: Buffer | Uint8Array) => Buffer.from(buf).toString("base64url");
