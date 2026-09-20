/** Output formatting. Dense and unambiguous — a model reads this, not a human. */
export declare function relativeTime(epochMs: number, now?: number): string;
/** A compact budget bar, so the model can see pressure at a glance. */
export declare function budgetBar(used: number, total: number, width?: number): string;
export declare function pluralize(n: number, singular: string, plural?: string): string;
/** Text result in the shape the MCP SDK expects. */
export declare function text(body: string): {
    content: {
        type: "text";
        text: string;
    }[];
};
