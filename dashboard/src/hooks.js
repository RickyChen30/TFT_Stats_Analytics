import { useEffect, useState, useRef } from "react";

// useFetch runs an async loader whenever its dependency list changes, exposing
// {data, loading, error}. Optionally re-runs on an interval (ms).
export function useFetch(loader, deps, intervalMs) {
  const [state, setState] = useState({ data: null, loading: true, error: null });
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    let alive = true;
    const run = () => {
      loaderRef
        .current()
        .then((data) => alive && setState({ data, loading: false, error: null }))
        .catch((error) => alive && setState((s) => ({ ...s, loading: false, error: error.message })));
    };
    run();
    let id;
    if (intervalMs) id = setInterval(run, intervalMs);
    return () => {
      alive = false;
      if (id) clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}
