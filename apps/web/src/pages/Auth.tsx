import { Trans, useLingui } from "@lingui/react/macro";
import { credentialIssue, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@rakazo/core";
import { Button, Input, Label } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { authClient } from "../lib/auth";
import type { AuthCapabilities } from "../lib/auth-capabilities";
import { fetchAuthCapabilities } from "../lib/auth-capabilities";
import { clearSpaceSelection } from "../lib/rpc";
import { authErrorText, credentialIssueText } from "../lib/user-error";

type AuthMode = "in" | "forgot";
const fieldClass = "mt-2 h-12 rounded-xl px-4 text-base md:text-base";
export const submitClass = "mt-3 h-12 w-full rounded-xl text-base";

export function AuthPage({ mode }: { mode: AuthMode }) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(() => {
    const code = searchParams.get("error");
    return code ? authErrorText({ code }, t`Could not continue`) : null;
  });
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [reset, setReset] = useState<AuthCapabilities | null>(null);
  const [capabilityError, setCapabilityError] = useState(false);
  const [capabilityAttempt, setCapabilityAttempt] = useState(0);
  useEffect(() => {
    setReset(null);
    setCapabilityError(false);
    let active = true;
    void fetchAuthCapabilities().then(
      (value) => {
        if (active) setReset(value);
      },
      () => {
        if (active) setCapabilityError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [mode, capabilityAttempt]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!reset || pending) return;
    const issue = credentialIssue({ email, password: mode === "forgot" ? undefined : password });
    if (issue) {
      setError(credentialIssueText(issue));
      return;
    }
    setPending(true);
    setError(null);
    try {
      if (mode === "forgot") {
        if (!reset.passwordReset || !reset.resetUrl) {
          setError(t`Password recovery is not configured for this server`);
          return;
        }
        const result = await authClient.requestPasswordReset({
          email: email.trim(),
          redirectTo: reset.resetUrl,
        });
        if (result.error) {
          setError(authErrorText(result.error, t`Could not send reset email`));
          return;
        }
        setSent(true);
        return;
      }
      const result = await authClient.signIn.email({ email: email.trim(), password });
      if (result.error) {
        setError(authErrorText(result.error, t`Could not continue`));
        return;
      }
      clearSpaceSelection();
      navigate(searchParams.get("next") === "/integrations/setup" ? "/integrations/setup" : "/app");
    } catch {
      setError(t`Could not reach the server`);
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthFrame
      onSubmit={submit}
      title={
        sent ? (
          <Trans>Check your email</Trans>
        ) : mode === "in" ? (
          <Trans>Sign in to Rakazo</Trans>
        ) : (
          <Trans>Reset your password</Trans>
        )
      }
    >
      {sent ? (
        <Link to="/sign-in" className="font-medium text-foreground">
          <Trans>Back to sign in</Trans>
        </Link>
      ) : (
        <>
          {capabilityError ? (
            <div role="alert" className="w-full text-center">
              <p>
                <Trans>Could not load sign-in options</Trans>
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={() => setCapabilityAttempt((value) => value + 1)}
              >
                <Trans>Retry</Trans>
              </Button>
            </div>
          ) : !reset ? (
            <p role="status">
              <Trans>Loading…</Trans>
            </p>
          ) : null}
          {reset ? (
            <>
              <div className="w-full">
                <Label htmlFor="email" className="text-muted-foreground">
                  <Trans>Email</Trans>
                </Label>
                <Input
                  id="email"
                  name="email"
                  autoComplete="username"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder={t`Your email address`}
                  type="email"
                  required
                  className={fieldClass}
                />
              </div>
              {mode === "in" ? (
                <div className="mt-4 w-full">
                  <Label htmlFor="current-password" className="text-muted-foreground">
                    <Trans>Password</Trans>
                  </Label>
                  <Input
                    id="current-password"
                    name="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder={t`Password`}
                    type="password"
                    required
                    maxLength={MAX_PASSWORD_LENGTH}
                    className={fieldClass}
                  />
                  {reset.passwordReset ? (
                    <div className="mt-2 text-right text-sm">
                      <Link to="/forgot-password" className="font-medium text-foreground">
                        <Trans>Forgot password?</Trans>
                      </Link>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {error ? (
                <p role="alert" className="mt-3 w-full text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              <Button type="submit" size="lg" disabled={pending} className={submitClass}>
                {pending ? (
                  <Trans>Working…</Trans>
                ) : mode === "in" ? (
                  <Trans>Continue with email</Trans>
                ) : (
                  <Trans>Send reset link</Trans>
                )}
              </Button>
              {mode === "forgot" ? (
                <Link to="/sign-in" className="mt-8 font-medium text-foreground">
                  <Trans>Back to sign in</Trans>
                </Link>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </AuthFrame>
  );
}

export function PasswordResetPage() {
  const { t } = useLingui();
  const [params] = useSearchParams();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | null>(
    params.get("error") || !params.get("token") ? t`This reset link is invalid or expired` : null,
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const token = params.get("token");
    if (!token) return;
    if (password !== confirmation) {
      setError(t`Passwords do not match`);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await authClient.resetPassword({ newPassword: password, token });
      if (result.error) {
        setError(authErrorText(result.error, t`Could not reset password`));
        return;
      }
      setComplete(true);
    } catch {
      setError(t`Could not reach the server`);
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthFrame onSubmit={submit} title={<Trans>Choose a new password</Trans>}>
      {complete ? (
        <div role="status" className="w-full text-center">
          <p className="text-lg">
            <Trans>Password updated</Trans>
          </p>
          <Link to="/sign-in" className="mt-6 inline-block font-medium">
            <Trans>Sign in</Trans>
          </Link>
        </div>
      ) : (
        <>
          <PasswordField
            id="new-password"
            label={t`New password`}
            value={password}
            onChange={setPassword}
          />
          <PasswordField
            id="confirm-password"
            label={t`Confirm password`}
            value={confirmation}
            onChange={setConfirmation}
            className="mt-4"
          />
          {error ? (
            <p role="alert" className="mt-3 w-full text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button
            type="submit"
            size="lg"
            disabled={pending || !params.get("token")}
            className={submitClass}
          >
            {pending ? <Trans>Working…</Trans> : <Trans>Reset password</Trans>}
          </Button>
          <Link to="/sign-in" className="mt-6 font-medium">
            <Trans>Back to sign in</Trans>
          </Link>
        </>
      )}
    </AuthFrame>
  );
}

export function AuthFrame({
  title,
  onSubmit,
  children,
}: {
  title: React.ReactNode;
  onSubmit: (event: React.FormEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-full items-center justify-center bg-background px-6 py-16 text-foreground">
      <form onSubmit={onSubmit} className="flex w-[460px] flex-col items-center">
        <div className="flex h-[74px] w-[74px] items-center justify-center gap-[11px] rounded-full bg-muted">
          <span className="h-5 w-[9px] rounded-full bg-primary" />
          <span className="h-5 w-[9px] rounded-full bg-primary" />
        </div>
        <h1 aria-live="polite" className="mb-9 mt-7 text-4xl font-medium tracking-tight">
          {title}
        </h1>
        {children}
      </form>
    </div>
  );
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  className = "",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <div className={`w-full ${className}`}>
      <Label htmlFor={id} className="text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        name={id}
        autoComplete="new-password"
        type="password"
        required
        minLength={MIN_PASSWORD_LENGTH}
        maxLength={MAX_PASSWORD_LENGTH}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={fieldClass}
      />
    </div>
  );
}
