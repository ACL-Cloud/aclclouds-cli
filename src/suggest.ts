/** Edit distance between two strings (Levenshtein), used to suggest a close command name. */
export function editDistance(a: string, b: string): number {
    const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i++) {
        let diagonal = previous[0]!;
        previous[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const above = previous[j]!;
            previous[j] = Math.min(previous[j]! + 1, previous[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
            diagonal = above;
        }
    }
    return previous[b.length]!;
}

/** The known command closest to `input`, when it is close enough to be a typo. */
export function suggestCommand(input: string, known: readonly string[]): string | undefined {
    const typed = input.toLowerCase();
    let best: { name: string; distance: number } | undefined;
    for (const name of known) {
        const distance = editDistance(typed, name.toLowerCase());
        if (distance <= Math.max(1, Math.floor(name.length / 3)) && (!best || distance < best.distance)) {
            best = { name, distance };
        }
    }
    return best?.name;
}
