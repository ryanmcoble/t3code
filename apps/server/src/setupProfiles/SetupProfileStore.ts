import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { SetupProfile, SetupProfileBinding, SetupProfileError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export interface ManagedSetupPath {
  readonly path: string;
  readonly root: string;
  readonly profile_id: string;
  readonly digest: string | null;
  readonly pending_digest: string | null;
  readonly overridden: number;
}

export class SetupProfileStore extends Context.Service<
  SetupProfileStore,
  {
    readonly changes: Stream.Stream<void>;
    readonly list: Effect.Effect<ReadonlyArray<SetupProfile>, SetupProfileError>;
    readonly get: (id: string, revision?: number) => Effect.Effect<SetupProfile, SetupProfileError>;
    readonly publish: (
      profile: SetupProfile,
      expectedRevision: number,
    ) => Effect.Effect<void, SetupProfileError>;
    readonly binding: Effect.Effect<SetupProfileBinding | null, SetupProfileError>;
    readonly saveBinding: (
      binding: SetupProfileBinding | null,
    ) => Effect.Effect<void, SetupProfileError>;
    readonly paths: Effect.Effect<ReadonlyArray<ManagedSetupPath>, SetupProfileError>;
    readonly savePath: (path: ManagedSetupPath) => Effect.Effect<void, SetupProfileError>;
    readonly removePath: (path: string) => Effect.Effect<void, SetupProfileError>;
    readonly grant: (
      profileId: string,
      destinationId: string,
      hash: string | null,
    ) => Effect.Effect<void, SetupProfileError>;
    readonly authorize: (
      profileId: string,
      destinationId: string,
      hash: string,
    ) => Effect.Effect<boolean, SetupProfileError>;
  }
>()("t3/setupProfiles/SetupProfileStore") {}

const decodeProfile = Schema.decodeUnknownEffect(Schema.fromJsonString(SetupProfile));
const decodeBinding = Schema.decodeUnknownEffect(Schema.fromJsonString(SetupProfileBinding));
const encodeProfile = Schema.encodeSync(Schema.fromJsonString(SetupProfile));
const isSetupError = Schema.is(SetupProfileError);
const encodeBinding = Schema.encodeEffect(Schema.fromJsonString(SetupProfileBinding));
const storageError = (cause: unknown) => new SetupProfileError({ reason: "storage", cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const epoch = yield* SubscriptionRef.make(0);
  const changes = SubscriptionRef.changes(epoch).pipe(Stream.map(() => undefined));
  const list = sql<{ manifest: string }>`SELECT r.manifest FROM setup_profile_revisions r
    WHERE r.revision = (SELECT MAX(p.revision) FROM setup_profile_revisions p WHERE p.profile_id = r.profile_id)
    ORDER BY r.profile_id`.pipe(
    Effect.flatMap((rows) => Effect.forEach(rows, (r) => decodeProfile(r.manifest))),
    Effect.mapError(storageError),
  );
  const get = Effect.fn("SetupProfileStore.get")(function* (id: string, revision?: number) {
    const rows = yield* sql<{ manifest: string }>`SELECT manifest FROM setup_profile_revisions
      WHERE profile_id = ${id} AND (${revision ?? null} IS NULL OR revision = ${revision ?? null})
      ORDER BY revision DESC LIMIT 1`.pipe(Effect.mapError(storageError));
    if (!rows[0]) return yield* new SetupProfileError({ reason: "not-found" });
    return yield* decodeProfile(rows[0].manifest).pipe(Effect.mapError(storageError));
  });
  const publish = Effect.fn("SetupProfileStore.publish")(function* (
    profile: SetupProfile,
    expected: number,
  ) {
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ revision: number | null }>`SELECT MAX(revision) AS revision
        FROM setup_profile_revisions WHERE profile_id = ${profile.id}`;
          if ((rows[0]?.revision ?? 0) !== expected) {
            if (
              rows[0]?.revision === profile.revision &&
              encodeProfile(yield* get(profile.id)) === encodeProfile(profile)
            )
              return;
            return yield* new SetupProfileError({ reason: "conflict" });
          }
          yield* sql`INSERT INTO setup_profile_revisions (profile_id, revision, manifest)
        VALUES (${profile.id}, ${profile.revision}, ${encodeProfile(profile)})`;
        }),
      )
      .pipe(Effect.mapError((cause) => (isSetupError(cause) ? cause : storageError(cause))));
    yield* SubscriptionRef.update(epoch, (n) => n + 1);
  });
  const binding = sql<{
    payload: string;
  }>`SELECT payload FROM setup_profile_binding WHERE id = 1`.pipe(
    Effect.flatMap((rows) => (rows[0] ? decodeBinding(rows[0].payload) : Effect.succeed(null))),
    Effect.mapError(storageError),
  );
  const saveBinding = Effect.fn("SetupProfileStore.saveBinding")(function* (
    value: SetupProfileBinding | null,
  ) {
    const payload =
      value === null ? null : yield* encodeBinding(value).pipe(Effect.mapError(storageError));
    const rows = yield* (
      payload === null
        ? sql`DELETE FROM setup_profile_binding WHERE id = 1 RETURNING id`
        : sql`INSERT INTO setup_profile_binding (id, payload) VALUES (1, ${payload})
          ON CONFLICT(id) DO UPDATE SET payload = excluded.payload WHERE setup_profile_binding.payload <> excluded.payload RETURNING id`
    ).pipe(Effect.mapError(storageError));
    if (rows.length) yield* SubscriptionRef.update(epoch, (n) => n + 1);
  });
  const paths = sql<ManagedSetupPath>`SELECT * FROM setup_profile_paths`.pipe(
    Effect.mapError(storageError),
  );
  const savePath = Effect.fn("SetupProfileStore.savePath")((p: ManagedSetupPath) =>
    sql`INSERT INTO setup_profile_paths (path, root, profile_id, digest, pending_digest, overridden)
      VALUES (${p.path}, ${p.root}, ${p.profile_id}, ${p.digest}, ${p.pending_digest}, ${p.overridden})
      ON CONFLICT(path) DO UPDATE SET digest = excluded.digest, pending_digest = excluded.pending_digest,
        overridden = excluded.overridden, profile_id = excluded.profile_id, root = excluded.root`.pipe(
      Effect.asVoid,
      Effect.mapError(storageError),
    ),
  );
  const removePath = Effect.fn("SetupProfileStore.removePath")((path: string) =>
    sql`DELETE FROM setup_profile_paths WHERE path = ${path}`.pipe(
      Effect.asVoid,
      Effect.mapError(storageError),
    ),
  );
  const grant = Effect.fn("SetupProfileStore.grant")(
    (profileId: string, destinationId: string, hash: string | null) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            if (hash === null)
              yield* sql`DELETE FROM setup_profile_grants WHERE profile_id = ${profileId} AND destination_environment_id = ${destinationId}`;
            else
              yield* sql`INSERT INTO setup_profile_grants VALUES (${hash}, ${profileId}, ${destinationId})`;
          }),
        )
        .pipe(Effect.mapError(storageError)),
  );
  const authorize = Effect.fn("SetupProfileStore.authorize")(
    (profileId: string, destinationId: string, hash: string) =>
      sql<{
        token_hash: string;
      }>`SELECT token_hash FROM setup_profile_grants WHERE token_hash = ${hash}
      AND profile_id = ${profileId} AND destination_environment_id = ${destinationId}`.pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.mapError(storageError),
      ),
  );
  return SetupProfileStore.of({
    changes,
    list,
    get,
    publish,
    binding,
    saveBinding,
    paths,
    savePath,
    removePath,
    grant,
    authorize,
  });
});

export const layer = Layer.effect(SetupProfileStore, make);
