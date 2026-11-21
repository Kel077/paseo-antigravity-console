/** The server's default name for the system sign-in; shown translated until the user renames it. */
export const DEFAULT_SYSTEM_LABEL = "System sign-in";

export function displayLabel(label: string, translate: (key: "systemName") => string): string {
  return label === DEFAULT_SYSTEM_LABEL ? translate("systemName") : label;
}
