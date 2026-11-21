import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Pressable, Text } from "react-native";

export type Colors = PluginSurfaceProps["theme"]["colors"];

export function Button({ label, onPress, colors, disabled = false, danger = false }: {
  label: string; onPress(): void; colors: Colors; disabled?: boolean; danger?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled}
    onPress={onPress} style={({ pressed }) => ({
      paddingHorizontal: 12, paddingVertical: 10, borderRadius: 7,
      backgroundColor: colors.surface2, opacity: disabled ? 0.5 : pressed ? 0.75 : 1,
    })}>
    <Text style={{ color: danger ? colors.statusDanger : colors.foreground, fontWeight: "500" }}>{label}</Text>
  </Pressable>;
}

export const actions = { flexDirection: "row", flexWrap: "wrap", gap: 8 } as const;
export function fieldStyle(colors: Colors) {
  return { color: colors.foreground, borderColor: colors.border, borderWidth: 1, borderRadius: 7, padding: 12 };
}
