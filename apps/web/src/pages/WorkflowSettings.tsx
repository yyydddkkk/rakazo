import { Trans, useLingui } from "@lingui/react/macro";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Disclosure,
  Input,
  Switch,
} from "@rakazo/ui-web";
import { useEffect, useId, useState } from "react";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

type WorkflowPackage = Awaited<ReturnType<typeof rpc.workflows.list>>[number];
type BotWorkflows = Awaited<ReturnType<typeof rpc.workflows.getBot>>;

export function WorkflowSettings({ botId, isPi = false }: { botId?: string; isPi?: boolean }) {
  const { t } = useLingui();
  const ids = useId();
  const [packages, setPackages] = useState<WorkflowPackage[]>([]);
  const [selection, setSelection] = useState<BotWorkflows>({ packageIds: [], alwaysUse: [] });
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const [removing, setRemoving] = useState<WorkflowPackage | null>(null);

  useEffect(() => {
    let active = true;
    setLoaded(false);
    Promise.all([rpc.workflows.list(), botId ? rpc.workflows.getBot({ botId }) : null])
      .then(([rows, selected]) => {
        if (!active) return;
        setPackages(rows);
        if (selected) setSelection(selected);
        setLoaded(true);
      })
      .catch((err) => {
        if (active) setError(errorText(err, t`Could not load workflows`));
      });
    return () => {
      active = false;
    };
  }, [botId, t]);

  async function change(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setPackages(await rpc.workflows.list());
      if (botId) setSelection(await rpc.workflows.getBot({ botId }));
      return true;
    } catch (err) {
      setError(errorText(err, t`Could not save workflows`));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveSelection(next: BotWorkflows) {
    if (!botId) return;
    await change(() => rpc.workflows.setBot({ botId, ...next }));
  }

  return (
    <section data-testid={botId ? "bot-workflows" : "space-workflows"} className="space-y-3">
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {!botId ? (
        <InstallWorkflow
          busy={busy}
          onInstall={(input) => change(() => rpc.workflows.install(input))}
        />
      ) : null}
      {loaded && botId && !packages.some((entry) => entry.enabled) ? (
        <Button variant="outline" size="sm" onClick={() => setManagerOpen(true)}>
          <Trans>Install</Trans>
        </Button>
      ) : null}
      {packages
        .filter((entry) => !botId || entry.enabled)
        .map((entry) => {
          const selected = selection.packageIds.includes(entry.id);
          return (
            <div key={entry.id} className="rounded-lg border border-border p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{entry.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {entry.alias} · {entry.version} · {entry.commit.slice(0, 8)}
                  </div>
                </div>
                <Switch
                  aria-label={entry.name}
                  disabled={busy}
                  checked={botId ? selected : entry.enabled}
                  onCheckedChange={(checked) => {
                    if (!botId) {
                      void change(() =>
                        rpc.workflows.setEnabled({ packageId: entry.id, enabled: checked }),
                      );
                      return;
                    }
                    void saveSelection({
                      packageIds: checked
                        ? [...selection.packageIds, entry.id]
                        : selection.packageIds.filter((id) => id !== entry.id),
                      alwaysUse: checked
                        ? selection.alwaysUse
                        : selection.alwaysUse.filter((key) => !key.startsWith(`${entry.alias}:`)),
                    });
                  }}
                />
              </div>
              {botId && selected ? (
                <fieldset className="mt-3 space-y-2">
                  <legend className="mb-2 text-sm text-muted-foreground">
                    <Trans>Always use</Trans>
                  </legend>
                  {entry.skills.map((skill) => {
                    const key = `${entry.alias}:${skill.name}`;
                    return (
                      <label
                        key={key}
                        htmlFor={`${ids}-${key}`}
                        className="flex items-center justify-between gap-3 text-sm"
                      >
                        <span>{skill.name}</span>
                        <Switch
                          disabled={busy}
                          id={`${ids}-${key}`}
                          checked={selection.alwaysUse.includes(key)}
                          onCheckedChange={(checked) => {
                            void saveSelection({
                              ...selection,
                              alwaysUse: checked
                                ? [...selection.alwaysUse, key]
                                : selection.alwaysUse.filter((value) => value !== key),
                            });
                          }}
                        />
                      </label>
                    );
                  })}
                </fieldset>
              ) : null}
              <Disclosure summary={<Trans>Details</Trans>} className="mt-2 text-sm">
                <dl className="mt-2 space-y-2 break-all text-xs text-muted-foreground">
                  <dt>
                    <Trans>Git URL</Trans>
                  </dt>
                  <dd>{entry.url}</dd>
                  <dt>
                    <Trans>Commit or tag</Trans>
                  </dt>
                  <dd>
                    {entry.requestedRevision} · {entry.commit}
                  </dd>
                  {entry.packagePath ? (
                    <>
                      <dt>
                        <Trans>Package path</Trans>
                      </dt>
                      <dd>{entry.packagePath}</dd>
                    </>
                  ) : null}
                  <dt>
                    <Trans>License</Trans>
                  </dt>
                  <dd>{entry.license ?? t`Not declared`}</dd>
                  <dt>
                    <Trans>Digest</Trans>
                  </dt>
                  <dd>{entry.digest}</dd>
                </dl>
                {entry.omitted.length ? (
                  <ul className="mt-3 list-inside list-disc text-xs text-muted-foreground">
                    {entry.omitted.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                ) : null}
                {isPi && entry.agents.length ? (
                  <p className="mt-3 text-xs text-muted-foreground">
                    <Trans>Only skills are available with Pi.</Trans>
                  </p>
                ) : null}
                {!botId ? (
                  <>
                    <form
                      className="mt-3 flex items-end gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const form = event.currentTarget;
                        const revision = String(new FormData(form).get("revision") ?? "").trim();
                        void change(() =>
                          rpc.workflows.updateVersion({ packageId: entry.id, revision }),
                        ).then((ok) => {
                          if (ok) form.reset();
                        });
                      }}
                    >
                      <label
                        htmlFor={`${ids}-${entry.id}`}
                        className="min-w-0 flex-1 text-xs text-muted-foreground"
                      >
                        <Trans>Commit or tag</Trans>
                        <Input
                          id={`${ids}-${entry.id}`}
                          name="revision"
                          required
                          disabled={busy}
                          className="mt-1"
                        />
                      </label>
                      <Button type="submit" variant="outline" size="sm" disabled={busy}>
                        <Trans>Update</Trans>
                      </Button>
                    </form>
                    <Button
                      className="mt-3"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => setRemoving(entry)}
                    >
                      <Trans>Uninstall</Trans>
                    </Button>
                  </>
                ) : null}
              </Disclosure>
            </div>
          );
        })}
      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Uninstall {removing?.name}?</Trans>
            </AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => {
                if (removing)
                  void change(() => rpc.workflows.remove({ packageId: removing.id })).then((ok) => {
                    if (ok) setRemoving(null);
                  });
              }}
            >
              <Trans>Uninstall</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog
        open={managerOpen}
        onOpenChange={(open) => {
          setManagerOpen(open);
          if (!open) void change(async () => undefined);
        }}
      >
        <DialogContent>
          <DialogTitle>
            <Trans>Workflows</Trans>
          </DialogTitle>
          {managerOpen ? <WorkflowSettings /> : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function InstallWorkflow({
  busy,
  onInstall,
}: {
  busy: boolean;
  onInstall: (input: { url: string; revision: string; packagePath?: string }) => Promise<boolean>;
}) {
  const ids = useId();
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  return (
    <Disclosure open={open} onOpenChange={setOpen} summary={<Trans>Install</Trans>}>
      <form
        className="mt-3 space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          const packagePath = String(data.get("packagePath") ?? "").trim();
          void onInstall({
            url: String(data.get("url") ?? "").trim(),
            revision: String(data.get("revision") ?? "").trim(),
            ...(packagePath ? { packagePath } : {}),
          }).then((ok) => {
            if (ok) {
              form.reset();
              setOpen(false);
            }
          });
        }}
      >
        <label htmlFor={`${ids}-url`} className="block text-sm text-muted-foreground">
          <Trans>Git URL</Trans>
          <Input
            id={`${ids}-url`}
            name="url"
            type="url"
            required
            disabled={busy}
            className="mt-1"
          />
        </label>
        <label htmlFor={`${ids}-revision`} className="block text-sm text-muted-foreground">
          <Trans>Commit or tag</Trans>
          <Input id={`${ids}-revision`} name="revision" required disabled={busy} className="mt-1" />
        </label>
        <Disclosure summary={<Trans>Package path</Trans>}>
          <Input aria-label={t`Package path`} name="packagePath" disabled={busy} className="mt-2" />
        </Disclosure>
        <p className="text-xs text-muted-foreground">
          <Trans>Third-party instructions can use this bot’s tools.</Trans>
        </p>
        <Button type="submit" disabled={busy}>
          <Trans>Install</Trans>
        </Button>
      </form>
    </Disclosure>
  );
}
