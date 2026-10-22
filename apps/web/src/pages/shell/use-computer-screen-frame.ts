import { useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";
import {
  embeddableScreenUrl,
  isProxiedScreenUrl,
  probeScreen,
  SCREEN_FRAME_LOAD_TIMEOUT_MS,
  screenFrameError,
  screenFrameMessage,
  screenFrameStarted,
} from "../../lib/computer-screen";

export function useComputerScreenFrame(screenUrl: string | null) {
  const { t } = useLingui();
  // The framed screen cannot be inspected from here. The proxy says when it refuses the page,
  // and the page reports its own state; nothing past "loading" by the timeout means it stalled.
  const [screenFrame, setScreenFrame] = useState<HTMLIFrameElement | null>(null);
  const [screenLoadError, setScreenLoadError] = useState<string | null>(null);
  const screenFrameReported = useRef(false);
  useEffect(() => {
    // Only a mounted frame resets the error: its own failure unmounts it, and Retry remounts it.
    if (!screenFrame) return;
    setScreenLoadError(null);
    screenFrameReported.current = false;
    const url = embeddableScreenUrl(screenUrl);
    if (!isProxiedScreenUrl(url)) return;
    let cancelled = false;
    const fallback = t`Could not connect to the computer screen`;
    void probeScreen(url, fallback).then((error) => {
      if (!cancelled && error && !screenFrameReported.current) setScreenLoadError(error);
    });
    const timer = setTimeout(() => {
      if (!cancelled && !screenFrameReported.current) setScreenLoadError(fallback);
    }, SCREEN_FRAME_LOAD_TIMEOUT_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [screenFrame, screenUrl]);
  useEffect(() => {
    if (!screenFrame) return;
    const fallback = t`Could not connect to the computer screen`;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== screenFrame.contentWindow) return;
      const message = screenFrameMessage(event.data);
      if (!message) return;
      if (screenFrameStarted(message)) screenFrameReported.current = true;
      setScreenLoadError(screenFrameError(message, fallback));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [screenFrame]);
  return { screenFrame, setScreenFrame, screenLoadError, setScreenLoadError };
}

export function useComputerViewport(computerOpen: boolean) {
  const [computerViewport, setComputerViewport] = useState<{
    height: number;
    offsetTop: number;
  } | null>(null);
  useEffect(() => {
    if (!computerOpen) {
      setComputerViewport(null);
      return;
    }
    const viewport = window.visualViewport;
    if (!viewport) return;
    const sync = () => {
      setComputerViewport({ height: viewport.height, offsetTop: viewport.offsetTop });
    };
    sync();
    viewport.addEventListener("resize", sync);
    viewport.addEventListener("scroll", sync);
    return () => {
      viewport.removeEventListener("resize", sync);
      viewport.removeEventListener("scroll", sync);
    };
  }, [computerOpen]);
  return computerViewport;
}
