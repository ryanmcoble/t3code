import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { serverEnvironment } from "~/state/server";
import { SetupProfileEnrollment } from "./SetupProfileEnrollment";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from "../ui/dialog";

export function NewEnvironmentSetupDialog({
  environmentId,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Set up this environment</DialogTitle>
          <DialogDescription>
            Choose a setup profile to apply its MCP connections and skills to enabled harnesses.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {!config ? (
            <p role="status">Waiting for the environment…</p>
          ) : config.environment.capabilities.setupProfiles !== 1 ? (
            <p>This environment needs a server update before it can use setup profiles.</p>
          ) : (
            <SetupProfileEnrollment
              destinationId={environmentId}
              instanceIds={config.providers.filter((p) => p.enabled).map((p) => p.instanceId)}
              onEnrolled={onClose}
            />
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
