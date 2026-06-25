/**
 * Pure, DOM-free validation for the Accounts form.
 * Lives outside shell.ts so it can be unit-tested without a DOM.
 */

export interface AccountFormValues {
  label: string;
  origin: string;
  username: string;
  password: string;
  totpSeed?: string;
}

export interface FieldError {
  field: keyof AccountFormValues;
  message: string;
}

const REQUIRED: ReadonlyArray<{ field: keyof AccountFormValues; label: string }> = [
  { field: "label", label: "Label" },
  { field: "origin", label: "Origin" },
  { field: "username", label: "Username" },
  { field: "password", label: "Password" },
];

/** True when `value` parses as an http(s) origin like https://example.com. */
export function isValidOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === "http:" || url.protocol === "https:") && url.host.length > 0;
}

/**
 * Validate the account form. Returns one FieldError per problem, in field
 * order; an empty array means the form is valid. Whitespace-only values count
 * as empty for every field except the password (which is taken verbatim).
 */
export function validateAccountForm(values: AccountFormValues): FieldError[] {
  const errors: FieldError[] = [];
  for (const { field, label } of REQUIRED) {
    const value = values[field] ?? "";
    const present = field === "password" ? value.length > 0 : value.trim().length > 0;
    if (!present) {
      errors.push({ field, message: `${label} is required.` });
    }
  }
  const origin = (values.origin ?? "").trim();
  if (origin && !isValidOrigin(origin)) {
    errors.push({ field: "origin", message: "Enter a full origin, e.g. https://example.com" });
  }
  return errors;
}
