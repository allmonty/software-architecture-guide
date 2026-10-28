import { useEffect, useState } from "react";

// Open every collapsed answer while printing so the page prints whole, then put them back.
function usePrintOpensDetails() {
  useEffect(() => {
    let opened: HTMLDetailsElement[] = [];
    const before = () => { opened = [...document.querySelectorAll<HTMLDetailsElement>(".notes details:not([open])")]; opened.forEach((d) => (d.open = true)); };
    const after = () => { opened.forEach((d) => (d.open = false)); opened = []; };
    addEventListener("beforeprint", before);
    addEventListener("afterprint", after);
    return () => { removeEventListener("beforeprint", before); removeEventListener("afterprint", after); };
  }, []);
}

/** Focus mode hides the legend and the trust card for undisturbed reading; the top bar stays. */
export function ReadingTools() {
  const [focus, setFocus] = useState(false);
  usePrintOpensDetails();
  useEffect(() => {
    document.documentElement.classList.toggle("focus", focus);
    return () => document.documentElement.classList.remove("focus");
  }, [focus]);
  return (
    <span className="reading-tools">
      <button aria-pressed={focus} onClick={() => setFocus(!focus)} title="Hide the legend and the summary card">Focus</button>
      <button onClick={() => print()} title="Print the note, or save it as a PDF from the print dialog">Print / PDF</button>
    </span>
  );
}
