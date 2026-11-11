import { computerAppAllowed } from "@t3tools/contracts";
import { useState } from "react";
import { TextInput, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListToggleRow } from "../../components/ui/ListToggleRow";

export function ComputerAppAccessPicker({
  rules,
  applications,
  disabled,
  supportsRules,
  onChange,
}: {
  readonly rules: ReadonlyArray<string>;
  readonly applications: ReadonlyArray<{ readonly bundleId: string; readonly name: string }>;
  readonly disabled: boolean;
  readonly supportsRules: boolean;
  readonly onChange: (rules: ReadonlyArray<string>) => void;
}) {
  const [search, setSearch] = useState("");
  const [wildcard, setWildcard] = useState("");
  const [showRules, setShowRules] = useState(false);
  const [limit, setLimit] = useState(40);
  const [savedSelection, setSavedSelection] = useState<ReadonlyArray<string>>([]);
  const all = rules.includes("*");
  const wildcards = rules.filter((rule) => rule !== "*" && rule.endsWith("*"));
  const filtered = applications.filter((app) =>
    `${app.name} ${app.bundleId}`.toLowerCase().includes(search.toLowerCase()),
  );
  const nextRule = wildcard.trim().endsWith("*") ? wildcard.trim() : `${wildcard.trim()}*`;
  const validRule =
    wildcard.trim().length > 0 && nextRule !== "*" && nextRule.indexOf("*") === nextRule.length - 1;
  return (
    <>
      <ListToggleRow
        label="Allow all applications"
        description="Selected harnesses may observe and control every app on this environment after saving."
        value={all}
        disabled={disabled || !supportsRules}
        onValueChange={(enabled) => {
          if (enabled) {
            setSavedSelection(rules);
            onChange(["*"]);
          } else onChange(savedSelection);
        }}
      />
      {!all ? (
        <>
          {rules
            .filter((rule) => !rule.endsWith("*"))
            .map((rule) => (
              <ListActionRow
                key={rule}
                label={`Remove ${applications.find((app) => app.bundleId === rule)?.name ?? rule}`}
                description="Remove from the allowed applications"
                disabled={disabled}
                onPress={() => onChange(rules.filter((item) => item !== rule))}
              />
            ))}
          <View className="gap-2 p-4">
            <Text className="text-sm text-foreground">Find applications</Text>
            <TextInput
              accessibilityLabel="Search applications"
              value={search}
              onChangeText={(text) => {
                setSearch(text);
                setLimit(40);
              }}
              placeholder="Search applications on this environment"
              className="rounded-lg border border-border p-3 text-foreground"
            />
          </View>
          {filtered.slice(0, limit).map((app) => (
            <ListToggleRow
              key={app.bundleId}
              label={app.name}
              value={computerAppAllowed(rules, app.bundleId, true)}
              disabled={disabled || computerAppAllowed(wildcards, app.bundleId, true)}
              description={
                computerAppAllowed(wildcards, app.bundleId, true)
                  ? "Allowed by a wildcard rule"
                  : undefined
              }
              onValueChange={(enabled) =>
                onChange(
                  enabled
                    ? [...rules, app.bundleId]
                    : rules.filter((rule) => rule !== app.bundleId),
                )
              }
            />
          ))}
          {filtered.length > limit ? (
            <ListActionRow label="Show more applications" onPress={() => setLimit(limit + 40)} />
          ) : null}
          {!filtered.length ? (
            <View className="p-4">
              <Text className="text-sm text-foreground-muted">
                {applications.length
                  ? "No applications match this search."
                  : "Check setup again to load applications from this environment."}
              </Text>
            </View>
          ) : null}
          <ListActionRow
            label={showRules ? "Hide wildcard rules" : "Manage wildcard rules"}
            description="Allow an app family, such as com.apple.*"
            onPress={() => setShowRules(!showRules)}
          />
          {showRules ? (
            <>
              {wildcards.map((rule) => (
                <ListActionRow
                  key={rule}
                  label={`Remove rule ${rule}`}
                  disabled={disabled}
                  onPress={() => onChange(rules.filter((item) => item !== rule))}
                />
              ))}
              <View className="gap-2 p-4">
                <Text className="text-sm text-foreground">Application identifier prefix</Text>
                <TextInput
                  accessibilityLabel="Application identifier prefix"
                  value={wildcard}
                  onChangeText={setWildcard}
                  placeholder="com.apple.*"
                  className="rounded-lg border border-border p-3 text-foreground"
                />
              </View>
              <ListActionRow
                label="Add wildcard rule"
                disabled={disabled || !supportsRules || !validRule || rules.includes(nextRule)}
                onPress={() => {
                  onChange([...rules, nextRule]);
                  setWildcard("");
                }}
              />
            </>
          ) : null}
        </>
      ) : null}
    </>
  );
}
