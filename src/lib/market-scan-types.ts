export type MarketConfidence =
    | "LOW"
    | "MEDIUM"
    | "HIGH";

export type MarketSignal = {
    signal: string;
    evidence: string;
    implication: string;
};

export type MarketCandidate = {
    name: string;
    concept: string;
    ageRange: string;
    targetRetailPriceMin: number;
    targetRetailPriceMax: number;
    trendEvidence: string;
    whyFit: string;
    differentiation: string;
    sourcingRequirements: string[];
    risks: string[];
    confidence: MarketConfidence;
};

export type MarketAvoidItem = {
    productConcept: string;
    reason: string;
};

export type MarketScanResult = {
    summary: string;
    marketSignals: MarketSignal[];
    candidates: MarketCandidate[];
    avoid: MarketAvoidItem[];
    nextStep: string;
    disclaimer: string;
};

export type MarketCitation = {
    title: string;
    url: string;
};

export type MarketScan = {
    id: number;
    result: MarketScanResult;
    citations: MarketCitation[];
    model: string;
    sourceCount: number;
    createdAt: string;
};
