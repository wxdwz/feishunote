export function extractDocTokenFromUrl(url: string): string | null {
    const patterns = [
        /feishu\.cn\/docx\/([a-zA-Z0-9]+)/,
        /feishu\.cn\/docs\/doc([a-zA-Z0-9]+)/,
        /larkoffice\.com\/docx\/([a-zA-Z0-9]+)/,
        /larkoffice\.com\/docs\/doc([a-zA-Z0-9]+)/,
        /feishu\.cn\/wiki\/[^?]*\?.*docToken=([a-zA-Z0-9]+)/,
    ];

    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) {
            return match[1];
        }
    }

    return null;
}

export function isFeishuDocUrl(url: string): boolean {
    return extractDocTokenFromUrl(url) !== null;
}

export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
