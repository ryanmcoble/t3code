import { useState } from "react";
import { computerAppAllowed } from "@t3tools/contracts";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";

export function ComputerAppAccessPicker({
  rules,
  applications,
  environmentLabel,
  disabled,
  supportsRules,
  onChange,
}: {
  readonly rules: ReadonlyArray<string>;
  readonly applications: ReadonlyArray<{ readonly bundleId: string; readonly name: string }>;
  readonly environmentLabel: string;
  readonly disabled: boolean;
  readonly supportsRules: boolean;
  readonly onChange: (rules: ReadonlyArray<string>) => void;
}) {
  const [search, setSearch] = useState("");
  const [wildcard, setWildcard] = useState("");
  const [savedSelection, setSavedSelection] = useState<ReadonlyArray<string>>([]);
  const allApplications = rules.includes("*");
  const wildcardRules = rules.filter((rule) => rule !== "*" && rule.endsWith("*"));
  const selectedApplications = rules.filter((rule) => !rule.endsWith("*"));
  const visibleApplications = applications.filter((app) =>
    `${app.name} ${app.bundleId}`.toLowerCase().includes(search.toLowerCase()),
  );
  const wildcardRule = wildcard.trim().endsWith("*") ? wildcard.trim() : `${wildcard.trim()}*`;
  const validWildcard =
    wildcard.trim().length > 0 &&
    wildcardRule !== "*" &&
    wildcardRule.indexOf("*") === wildcardRule.length - 1;
  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">Application access</p>
      <ToggleGroup
        aria-label="Allowed application scope"
        value={[allApplications ? "all" : "selected"]}
        disabled={disabled}
        onValueChange={(values) => {
          if (values[0] === "all" && !allApplications) {
            setSavedSelection(rules);
            onChange(["*"]);
          }
          if (values[0] === "selected" && allApplications) onChange(savedSelection);
        }}
      >
        <ToggleGroupItem value="selected">Selected applications</ToggleGroupItem>
        <ToggleGroupItem value="all" disabled={!supportsRules}>
          All applications
        </ToggleGroupItem>
      </ToggleGroup>
      {allApplications ? (
        <Alert variant="warning">
          <AlertTitle>Access to every application</AlertTitle>
          <AlertDescription>
            The selected harnesses will be able to observe and control any application on{" "}
            {environmentLabel}. Save desktop access to apply this choice.
          </AlertDescription>
        </Alert>
      ) : (
        <>
          {selectedApplications.length ? (
            <ul className="divide-y divide-border">
              {selectedApplications.map((id) => (
                <li key={id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span>{applications.find((app) => app.bundleId === id)?.name ?? id}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => onChange(rules.filter((rule) => rule !== id))}
                    aria-label={`Remove ${applications.find((app) => app.bundleId === id)?.name ?? id} from allowed apps`}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              Choose the applications these harnesses may control.
            </p>
          )}
          <Input
            aria-label="Search applications"
            placeholder="Search applications on this environment"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            disabled={disabled}
          />
          <div
            className="max-h-64 overflow-y-auto divide-y divide-border"
            role="group"
            aria-label="Applications on this environment"
          >
            {visibleApplications.map((app) => {
              const fromWildcard = computerAppAllowed(wildcardRules, app.bundleId, true);
              return (
                <label key={app.bundleId} className="flex min-h-11 items-center gap-3 py-2 text-sm">
                  <Checkbox
                    checked={computerAppAllowed(rules, app.bundleId, true)}
                    disabled={disabled || fromWildcard}
                    onCheckedChange={(checked) =>
                      onChange(
                        checked
                          ? [...rules, app.bundleId]
                          : rules.filter((rule) => rule !== app.bundleId),
                      )
                    }
                  />
                  <span className="min-w-0 flex-1 truncate">{app.name}</span>
                  {fromWildcard ? (
                    <span className="text-xs text-muted-foreground">Allowed by rule</span>
                  ) : null}
                </label>
              );
            })}
            {!visibleApplications.length ? (
              <p className="py-3 text-sm text-muted-foreground">
                {applications.length
                  ? "No applications match this search."
                  : "Check setup again to load this environment’s applications."}
              </p>
            ) : null}
          </div>
          <details className="space-y-3">
            <summary className="cursor-pointer text-sm text-muted-foreground">
              Wildcard rules
            </summary>
            <p className="text-xs text-muted-foreground">
              Allow a family of applications using an identifier prefix, such as com.apple.*.
            </p>
            {wildcardRules.map((rule) => (
              <div key={rule} className="flex items-center justify-between gap-3 text-sm">
                <code>{rule}</code>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => onChange(rules.filter((item) => item !== rule))}
                >
                  Remove rule
                </Button>
              </div>
            ))}
            <label className="block space-y-1 text-sm">
              Application identifier prefix
              <Input
                value={wildcard}
                onChange={(event) => setWildcard(event.target.value)}
                placeholder="com.apple.*"
                disabled={disabled}
              />
            </label>
            <Button
              size="sm"
              variant="outline"
              disabled={
                disabled || !supportsRules || !validWildcard || rules.includes(wildcardRule)
              }
              onClick={() => {
                onChange([...rules, wildcardRule]);
                setWildcard("");
              }}
            >
              Add wildcard rule
            </Button>
          </details>
        </>
      )}
    </div>
  );
}
