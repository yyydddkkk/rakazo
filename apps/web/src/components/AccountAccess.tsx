import { Trans, useLingui } from "@lingui/react/macro";
import type { AccountSecurity } from "@rakazo/contracts";
import { Button, Input, Label } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { fetchAccountSecurity } from "../lib/account-security";
import { authClient } from "../lib/auth";
import { authErrorText } from "../lib/user-error";

export function AccountAccess({
  onSecurity,
}: {
  onSecurity?: (security: AccountSecurity) => void;
}) {
  const { t } = useLingui();
  const [security, setSecurity] = useState<AccountSecurity | null>(null);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(() => {
    const code = new URLSearchParams(window.location.search).get("error");
    return code ? authErrorText({ code }, t`Could not continue`) : null;
  });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void fetchAccountSecurity()
      .then((value) => {
        if (active) {
          setSecurity(value);
          onSecurity?.(value);
        }
      })
      .catch(() => {
        if (active) setError(t`Could not continue`);
      });
    return () => {
      active = false;
    };
  }, [attempt, onSecurity]);
  async function action(run: () => Promise<unknown>) {
    setPending(true);
    setError(null);
    try {
      await run();
    } catch (error) {
      setError(error instanceof Error ? error.message : t`Could not continue`);
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="space-y-3">
      <Button
        variant="outline"
        className="text-destructive hover:text-destructive"
        onClick={() => setOpen((value) => !value)}
      >
        <Trans>Delete account</Trans>
      </Button>
      {open ? (
        <div className="space-y-3">
          <p className="text-sm">
            <Trans>This permanently deletes your account and data.</Trans>
          </p>
          {!security ? (
            <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>
              <Trans>Retry</Trans>
            </Button>
          ) : security.hasPassword ? (
            <div>
              <Label htmlFor="delete-password">
                <Trans>Current password</Trans>
              </Label>
              <Input
                id="delete-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
          ) : null}
          <Button
            variant="destructive"
            disabled={pending || !security?.hasPassword || !password}
            onClick={() =>
              void action(async () => {
                const current = await fetchAccountSecurity();
                setSecurity(current);
                onSecurity?.(current);
                if (!current.hasPassword || !password) return;
                const result = await authClient.deleteUser({ password });
                if (result.error)
                  throw new Error(authErrorText(result.error, t`Could not continue`));
                window.location.assign("/sign-in");
              })
            }
          >
            <Trans>Delete account</Trans>
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
