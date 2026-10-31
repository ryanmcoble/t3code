import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

import { ResolvedKeybindingsConfig } from "./keybindings.ts";
import { DesktopVoiceShortcutConfig } from "./voiceInput.ts";

const decode = <S extends Schema.Top>(
  schema: S,
  input: unknown,
): Effect.Effect<Schema.Schema.Type<S>, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(schema as never)(input) as Effect.Effect<
    Schema.Schema.Type<S>,
    Schema.SchemaError,
    never
  >;

const shortcut = {
  key: "p",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  modKey: true,
};

it.effect("drops resolved rules with commands this build does not know", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(ResolvedKeybindingsConfig, [
      { command: "terminal.toggle", shortcut },
      { command: "someFuture.toggle", shortcut },
      { command: "filePicker.toggle", shortcut },
    ]);
    assert.deepEqual(
      parsed.map((rule) => rule.command),
      ["terminal.toggle", "filePicker.toggle"],
    );
  }),
);

it.effect("drops malformed resolved rule entries", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(ResolvedKeybindingsConfig, [
      "garbage",
      { command: "terminal.toggle", shortcut },
      null,
    ]);
    assert.deepEqual(
      parsed.map((rule) => rule.command),
      ["terminal.toggle"],
    );
  }),
);

it.effect("preserves the literal Space key in the desktop dictation shortcut", () =>
  Effect.gen(function* () {
    const value = {
      ownerKey: "composer",
      enabled: true,
      shortcut: { ...shortcut, key: " ", shiftKey: true },
    };
    const parsed = yield* decode(DesktopVoiceShortcutConfig, value);
    assert.deepEqual(parsed, value);
    const rules = yield* decode(ResolvedKeybindingsConfig, [
      { command: "composer.globalDictation", shortcut: value.shortcut },
    ]);
    assert.strictEqual(rules.length, 1);
    assert.strictEqual(rules[0]!.shortcut.key, " ");
  }),
);
