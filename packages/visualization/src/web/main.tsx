/** Visualization SPA의 진입점입니다. 화면은 hash로 고릅니다: `#/`는 Session 목록, `#/session/<에이전트 id>/<Session ID>`는 Session Graph입니다. */

import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { parseSessionHash } from "./routes";
import { SessionGraph } from "./session-graph";
import { SessionList } from "./session-list";

function App() {
    const [hash, setHash] = useState(location.hash);
    useEffect(() => {
        const onChange = () => setHash(location.hash);
        addEventListener("hashchange", onChange);
        return () => removeEventListener("hashchange", onChange);
    }, []);
    const session = parseSessionHash(hash);
    return session === undefined ? (
        <SessionList />
    ) : (
        <SessionGraph key={`${session.agentKind}/${session.sessionId}`} session={session} />
    );
}

const root = document.getElementById("app");
if (root !== null) render(<App />, root);
