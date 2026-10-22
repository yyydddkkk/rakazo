import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Spinner } from "@rakazo/ui-web";

export function ComputerScreenError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 px-6 text-center text-sm">
      <p className="text-destructive">{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <Trans>Retry screen</Trans>
      </Button>
    </div>
  );
}

export function ComputerBootingStatus() {
  const { t } = useLingui();
  return (
    <span className="flex flex-col items-center gap-3">
      <Spinner aria-hidden className="size-5 motion-reduce:animate-none" />
      {t`Booting live desktop…`}
    </span>
  );
}
