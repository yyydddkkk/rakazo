import type { NavigateFunction, NavigateOptions, To } from "react-router-dom";

/** Async work from a departing shell must not move the next shell's route. */
export function guardShellNavigate(
  getNavigate: () => NavigateFunction,
  isAlive: () => boolean,
): NavigateFunction {
  return (to: To | number, options?: NavigateOptions) => {
    if (!isAlive()) return;
    const navigate = getNavigate();
    return typeof to === "number" ? navigate(to) : navigate(to, options);
  };
}
