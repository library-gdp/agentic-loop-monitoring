import { UnauthorizedError } from "./api";

/** 불러오기 실패를 보입니다. 토큰이 없으면 접속 URL을 여는 방법을 안내합니다. */
export function ErrorMessage({ error }: { readonly error: unknown }) {
    if (error instanceof UnauthorizedError) {
        return (
            <div class="error">
                Not signed in. Run <code>agentoscope url</code> and open the URL it prints.
            </div>
        );
    }
    return (
        <div class="error">
            Cannot load: {error instanceof Error ? error.message : String(error)}
        </div>
    );
}
