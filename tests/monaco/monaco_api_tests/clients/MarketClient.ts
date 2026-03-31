import { BaseApiClient, MonacoApiError } from './BaseApiClient';

// ============================================================================
// Type Definitions
// ============================================================================

export type MarketType = 'SPOT' | 'MARGIN';

export interface TradingPairResponse {
    id: string;
    base_token: string;
    quote_token: string;
    symbol: string;
    base_decimals: number;
    quote_decimals: number;
    min_order_size: string;
    max_order_size: string;
    tick_size: string;
    maker_fee_bps: number;
    taker_fee_bps: number;
    market_type: string;
    is_active: boolean;
}

export interface PaginatedTradingPairs {
    data: TradingPairResponse[];
    page: number;
    limit: number;
    total: number;
    total_pages: number;
}

export interface MarketPairsQuery {
    page?: number;
    limit?: number;
    market_type?: MarketType;
    base_token?: string;
    quote_token?: string;
    is_active?: boolean;
}

export interface MarketStats {
    total_pairs: number;
    active_pairs: number;
    spot_pairs: number;
    margin_pairs: number;
    most_popular_base_tokens: Array<{
        token: string;
        pair_count: number;
    }>;
    most_popular_quote_tokens: Array<{
        token: string;
        pair_count: number;
    }>;
}

export interface TradingPairInfo {
    symbol: string;
    base_token: string;
    quote_token: string;
    market_type: MarketType;
    is_active: boolean;
    fees: {
        maker_fee_bps: number;
        taker_fee_bps: number;
        maker_fee_percentage: string;
        taker_fee_percentage: string;
    };
    limits: {
        min_order_size: string;
        max_order_size: string;
        tick_size: string;
    };
    precision: {
        base_decimals: number;
        quote_decimals: number;
    };
}

export interface MarketOverview {
    total_trading_pairs: number;
    active_trading_pairs: number;
    market_types: {
        spot: number;
        margin: number;
    };
    top_base_tokens: Array<{
        token: string;
        pair_count: number;
    }>;
    top_quote_tokens: Array<{
        token: string;
        pair_count: number;
    }>;
}

// ============================================================================
// MarketClient Class
// ============================================================================

export default class MarketClient extends BaseApiClient {
    constructor(url: string, clientId: string) {
        super(url, clientId);
    }

    async getTradingPairs(
        query?: MarketPairsQuery,
        accessToken?: string
    ): Promise<PaginatedTradingPairs> {
        const queryString = query ? this.buildQueryString(query) : '';
        return this.get<PaginatedTradingPairs>(
            `/api/v1/market/pairs${queryString}`,
            accessToken
        );
    }

    async getTradingPairBySymbol(
        symbol: string,
        accessToken?: string
    ): Promise<TradingPairResponse> {
        this.validateRequired({ symbol }, ['symbol']);
        const encodedSymbol = encodeURIComponent(symbol);
        return this.get<TradingPairResponse>(
            `/api/v1/market/pairs/${encodedSymbol}`,
            accessToken
        );
    }

    async getAllTradingPairs(
        filters?: Omit<MarketPairsQuery, 'page' | 'limit'>,
        accessToken?: string
    ): Promise<TradingPairResponse[]> {
        const allPairs: TradingPairResponse[] = [];
        let currentPage = 1;
        let totalPages = 1;

        do {
            const response = await this.getTradingPairs(
                {
                    ...filters,
                    page: currentPage,
                    limit: 100, // Max limit
                },
                accessToken
            );

            allPairs.push(...response.data);
            totalPages = response.total_pages;
            currentPage++;
        } while (currentPage <= totalPages);

        return allPairs;
    }

    async getActiveTradingPairs(
        filters?: Omit<MarketPairsQuery, 'page' | 'limit' | 'is_active'>,
        accessToken?: string
    ): Promise<TradingPairResponse[]> {
        return this.getAllTradingPairs(
            {
                ...filters,
                is_active: true,
            },
            accessToken
        );
    }

    async getTradingPairsByMarketType(
        marketType: MarketType,
        accessToken?: string
    ): Promise<TradingPairResponse[]> {
        return this.getAllTradingPairs(
            {
                market_type: marketType,
                is_active: true,
            },
            accessToken
        );
    }

    async getTradingPairsByBaseToken(
        baseToken: string,
        accessToken?: string
    ): Promise<TradingPairResponse[]> {
        return this.getAllTradingPairs(
            {
                base_token: baseToken,
                is_active: true,
            },
            accessToken
        );
    }

    async getTradingPairsByQuoteToken(
        quoteToken: string,
        accessToken?: string
    ): Promise<TradingPairResponse[]> {
        return this.getAllTradingPairs(
            {
                quote_token: quoteToken,
                is_active: true,
            },
            accessToken
        );
    }

    async searchTradingPairs(
        searchTerm: string,
        accessToken?: string
    ): Promise<TradingPairResponse[]> {
        const allPairs = await this.getAllTradingPairs({ is_active: true }, accessToken);

        return allPairs.filter(pair =>
            pair.symbol.toLowerCase().includes(searchTerm.toLowerCase()) ||
            pair.base_token.toLowerCase().includes(searchTerm.toLowerCase()) ||
            pair.quote_token.toLowerCase().includes(searchTerm.toLowerCase())
        );
    }

    /**
     * Get comprehensive market statistics
     */
    async getMarketStats(accessToken?: string): Promise<MarketStats> {
        const allPairs = await this.getAllTradingPairs({}, accessToken);

        const activePairs = allPairs.filter(pair => pair.is_active);
        const spotPairs = activePairs.filter(pair => pair.market_type === 'Spot');
        const marginPairs = activePairs.filter(pair => pair.market_type === 'Margin');

        // Count base tokens
        const baseTokenCounts = new Map<string, number>();
        activePairs.forEach(pair => {
            const count = baseTokenCounts.get(pair.base_token) || 0;
            baseTokenCounts.set(pair.base_token, count + 1);
        });

        // Count quote tokens
        const quoteTokenCounts = new Map<string, number>();
        activePairs.forEach(pair => {
            const count = quoteTokenCounts.get(pair.quote_token) || 0;
            quoteTokenCounts.set(pair.quote_token, count + 1);
        });

        return {
            total_pairs: allPairs.length,
            active_pairs: activePairs.length,
            spot_pairs: spotPairs.length,
            margin_pairs: marginPairs.length,
            most_popular_base_tokens: Array.from(baseTokenCounts.entries())
                .map(([token, count]) => ({ token, pair_count: count }))
                .sort((a, b) => b.pair_count - a.pair_count)
                .slice(0, 10),
            most_popular_quote_tokens: Array.from(quoteTokenCounts.entries())
                .map(([token, count]) => ({ token, pair_count: count }))
                .sort((a, b) => b.pair_count - a.pair_count)
                .slice(0, 10),
        };
    }

    async getMarketOverview(accessToken?: string): Promise<MarketOverview> {
        const stats = await this.getMarketStats(accessToken);

        return {
            total_trading_pairs: stats.total_pairs,
            active_trading_pairs: stats.active_pairs,
            market_types: {
                spot: stats.spot_pairs,
                margin: stats.margin_pairs,
            },
            top_base_tokens: stats.most_popular_base_tokens.slice(0, 5),
            top_quote_tokens: stats.most_popular_quote_tokens.slice(0, 5),
        };
    }

    async getTradingPairInfo(
        symbol: string,
        accessToken?: string
    ): Promise<TradingPairResponse> {
        return await this.getTradingPairBySymbol(symbol, accessToken);
    }

    async isTradingPairActive(
        symbol: string,
        accessToken?: string
    ): Promise<boolean> {
        try {
            const pair = await this.getTradingPairBySymbol(symbol, accessToken);
            return pair.is_active;
        } catch (error) {
            if (error instanceof MonacoApiError && error.status === 404) {
                return false;
            }
            throw error;
        }
    }

    async getTradingPairByTokens(
        baseToken: string,
        quoteToken: string,
        accessToken?: string
    ): Promise<TradingPairResponse | null> {
        try {
            const symbol = `${baseToken}-${quoteToken}`;
            return await this.getTradingPairBySymbol(symbol, accessToken);
        } catch (error) {
            if (error instanceof MonacoApiError && error.status === 404) {
                return null;
            }
            throw error;
        }
    }

    async getAvailableBaseTokens(accessToken?: string): Promise<string[]> {
        const allPairs = await this.getAllTradingPairs({ is_active: true }, accessToken);
        const baseTokens = new Set(allPairs.map(pair => pair.base_token));
        return Array.from(baseTokens).sort();
    }


    async getAvailableQuoteTokens(accessToken?: string): Promise<string[]> {
        const allPairs = await this.getAllTradingPairs({ is_active: true }, accessToken);
        const quoteTokens = new Set(allPairs.map(pair => pair.quote_token));
        return Array.from(quoteTokens).sort();
    }

    async getTradingPairsByFeeRange(
        minMakerFeeBps?: number,
        maxMakerFeeBps?: number,
        minTakerFeeBps?: number,
        maxTakerFeeBps?: number,
        accessToken?: string
    ): Promise<TradingPairResponse[]> {
        const allPairs = await this.getAllTradingPairs({ is_active: true }, accessToken);

        return allPairs.filter(pair => {
            const makerFeeOk = !minMakerFeeBps || !maxMakerFeeBps ||
                (pair.maker_fee_bps >= minMakerFeeBps && pair.maker_fee_bps <= maxMakerFeeBps);
            const takerFeeOk = !minTakerFeeBps || !maxTakerFeeBps ||
                (pair.taker_fee_bps >= minTakerFeeBps && pair.taker_fee_bps <= maxTakerFeeBps);

            return makerFeeOk && takerFeeOk;
        });
    }

    async getTradingPairsByOrderSize(
        minOrderSize?: string,
        maxOrderSize?: string,
        accessToken?: string
    ): Promise<TradingPairResponse[]> {
        const allPairs = await this.getAllTradingPairs({ is_active: true }, accessToken);

        return allPairs.filter(pair => {
            const minOk = !minOrderSize || parseFloat(pair.min_order_size) <= parseFloat(minOrderSize);
            const maxOk = !maxOrderSize || parseFloat(pair.max_order_size) >= parseFloat(maxOrderSize);

            return minOk && maxOk;
        });
    }

    async compareTradingPairs(
        symbol1: string,
        symbol2: string,
        accessToken?: string
    ): Promise<{
        pair1: TradingPairInfo;
        pair2: TradingPairInfo;
        comparison: {
            fee_difference: {
                maker_fee_bps: number;
                taker_fee_bps: number;
            };
            size_limit_difference: {
                min_order_size_ratio: string;
                max_order_size_ratio: string;
            };
            precision_difference: {
                base_decimals: number;
                quote_decimals: number;
            };
        };
    }> {
        const [pair1, pair2] = await Promise.all([
            this.getTradingPairInfo(symbol1, accessToken),
            this.getTradingPairInfo(symbol2, accessToken),
        ]);

        const makerFeeDiff = pair1.fees.maker_fee_bps - pair2.fees.maker_fee_bps;
        const takerFeeDiff = pair1.fees.taker_fee_bps - pair2.fees.taker_fee_bps;

        const minOrderSizeRatio = (parseFloat(pair1.limits.min_order_size) /
            parseFloat(pair2.limits.min_order_size)).toFixed(4);
        const maxOrderSizeRatio = (parseFloat(pair1.limits.max_order_size) /
            parseFloat(pair2.limits.max_order_size)).toFixed(4);

        return {
            pair1,
            pair2,
            comparison: {
                fee_difference: {
                    maker_fee_bps: makerFeeDiff,
                    taker_fee_bps: takerFeeDiff,
                },
                size_limit_difference: {
                    min_order_size_ratio: minOrderSizeRatio,
                    max_order_size_ratio: maxOrderSizeRatio,
                },
                precision_difference: {
                    base_decimals: pair1.precision.base_decimals - pair2.precision.base_decimals,
                    quote_decimals: pair1.precision.quote_decimals - pair2.precision.quote_decimals,
                },
            },
        };
    }

    /**
     * Get market summary for a specific token
     */
    async getTokenMarketSummary(
        token: string,
        accessToken?: string
    ): Promise<{
        token: string;
        as_base_token: {
            pair_count: number;
            trading_pairs: string[];
        };
        as_quote_token: {
            pair_count: number;
            trading_pairs: string[];
        };
        total_pairs: number;
        market_types: {
            spot: number;
            margin: number;
        };
    }> {
        const allPairs = await this.getAllTradingPairs({ is_active: true }, accessToken);

        const asBaseToken = allPairs.filter(pair => pair.base_token === token);
        const asQuoteToken = allPairs.filter(pair => pair.quote_token === token);
        const totalPairs = asBaseToken.length + asQuoteToken.length;

        const spotPairs = allPairs.filter(pair =>
            (pair.base_token === token || pair.quote_token === token) &&
            pair.market_type === 'Spot'
        );
        const marginPairs = allPairs.filter(pair =>
            (pair.base_token === token || pair.quote_token === token) &&
            pair.market_type === 'Margin'
        );

        return {
            token,
            as_base_token: {
                pair_count: asBaseToken.length,
                trading_pairs: asBaseToken.map(pair => pair.symbol),
            },
            as_quote_token: {
                pair_count: asQuoteToken.length,
                trading_pairs: asQuoteToken.map(pair => pair.symbol),
            },
            total_pairs: totalPairs,
            market_types: {
                spot: spotPairs.length,
                margin: marginPairs.length,
            },
        };
    }
}
