import { BaseApiClient, MonacoApiError } from './BaseApiClient';

// ============================================================================
// Type Definitions
// ============================================================================

export interface PriceLevel {
    price: string;
    quantity: string;
    order_count: number;
}

export interface OrderbookSnapshot {
    trading_pair: string;
    trading_pair_id: string;
    bids: PriceLevel[];
    asks: PriceLevel[];
    last_update: string;
}

export interface OrderbookDepth extends OrderbookSnapshot {
    depth: number;
}

export interface DepthQuery {
    levels?: number;
}

export interface MarketPrice {
    best_bid: string;
    best_ask: string;
    spread: string;
    mid_price: string;
    last_update: string;
}

export interface LiquidityInfo {
    total_bid_liquidity: string;
    total_ask_liquidity: string;
    best_bid_price: string;
    best_ask_price: string;
    spread_percentage: string;
    price_levels: number;
}

export interface OrderbookStats {
    trading_pair: string;
    total_orders: number;
    total_volume: string;
    price_range: {
        min_price: string;
        max_price: string;
    };
    liquidity_distribution: {
        top_5_levels_bid: string;
        top_5_levels_ask: string;
        top_10_levels_bid: string;
        top_10_levels_ask: string;
    };
}

export default class OrderbookClient extends BaseApiClient {
    constructor(url: string, clientId: string) {
        super(url, clientId);
    }

    /**
     * Get complete orderbook snapshot for a trading pair
     */
    async getOrderbookSnapshot(
        tradingPair: string,
        accessToken?: string
    ): Promise<OrderbookSnapshot> {
        this.validateRequired({ tradingPair }, ['tradingPair']);

        return this.get<OrderbookSnapshot>(
            `/api/v1/orderbook/${tradingPair}`,
            accessToken
        );
    }

    /**
     * Get orderbook depth with configurable number of levels
     */
    async getOrderbookDepth(
        tradingPair: string,
        options?: {
            levels?: number;
            accessToken?: string;
        }
    ): Promise<OrderbookDepth> {
        this.validateRequired({ tradingPair }, ['tradingPair']);

        const queryParams: DepthQuery = {};
        if (options?.levels) {
            queryParams.levels = Math.min(options.levels, 100); // Cap at 100 levels
        }

        const queryString = Object.keys(queryParams).length > 0
            ? this.buildQueryString(queryParams)
            : '';

        return this.get<OrderbookDepth>(
            `/api/v1/orderbook/${tradingPair}/depth${queryString}`,
            options?.accessToken
        );
    }

    /**
     * Get current market price information (best bid/ask, spread, mid-price)
     */
    async getMarketPrice(
        tradingPair: string,
        accessToken?: string
    ): Promise<MarketPrice> {
        const orderbook = await this.getOrderbookSnapshot(tradingPair, accessToken);

        if (orderbook.bids.length === 0 || orderbook.asks.length === 0) {
            throw new MonacoApiError(
                `No liquidity available for trading pair ${tradingPair}`,
                404
            );
        }

        const bestBid = parseFloat(orderbook.bids[0].price);
        const bestAsk = parseFloat(orderbook.asks[0].price);
        const spread = bestAsk - bestBid;
        const midPrice = (bestBid + bestAsk) / 2;

        return {
            best_bid: bestBid.toString(),
            best_ask: bestAsk.toString(),
            spread: spread.toString(),
            mid_price: midPrice.toString(),
            last_update: orderbook.last_update,
        };
    }

    /**
     * Get best bid price
     */
    async getBestBidPrice(
        tradingPair: string,
        accessToken?: string
    ): Promise<string> {
        const marketPrice = await this.getMarketPrice(tradingPair, accessToken);
        return marketPrice.best_bid;
    }

    /**
     * Get best ask price
     */
    async getBestAskPrice(
        tradingPair: string,
        accessToken?: string
    ): Promise<string> {
        const marketPrice = await this.getMarketPrice(tradingPair, accessToken);
        return marketPrice.best_ask;
    }

    async getMidPrice(
        tradingPair: string,
        accessToken?: string
    ): Promise<string> {
        const marketPrice = await this.getMarketPrice(tradingPair, accessToken);
        return marketPrice.mid_price;
    }

    /**
     * Get current spread (ask - bid)
     */
    async getSpread(
        tradingPair: string,
        accessToken?: string
    ): Promise<string> {
        const marketPrice = await this.getMarketPrice(tradingPair, accessToken);
        return marketPrice.spread;
    }

    /**
     * Get spread as percentage of mid-price
     */
    async getSpreadPercentage(
        tradingPair: string,
        accessToken?: string
    ): Promise<string> {
        const marketPrice = await this.getMarketPrice(tradingPair, accessToken);
        const spread = parseFloat(marketPrice.spread);
        const midPrice = parseFloat(marketPrice.mid_price);

        if (midPrice === 0) {
            return '0';
        }

        return ((spread / midPrice) * 100).toString();
    }

    // ============================================================================
    // Liquidity Analysis Methods
    // ============================================================================

    /**
     * Get detailed liquidity information
     */
    async getLiquidityInfo(
        tradingPair: string,
        accessToken?: string
    ): Promise<LiquidityInfo> {
        const orderbook = await this.getOrderbookSnapshot(tradingPair, accessToken);

        if (orderbook.bids.length === 0 || orderbook.asks.length === 0) {
            throw new MonacoApiError(
                `No liquidity available for trading pair ${tradingPair}`,
                404
            );
        }

        const totalBidLiquidity = orderbook.bids
            .reduce((sum, level) => sum + parseFloat(level.quantity), 0)
            .toString();

        const totalAskLiquidity = orderbook.asks
            .reduce((sum, level) => sum + parseFloat(level.quantity), 0)
            .toString();

        const bestBidPrice = parseFloat(orderbook.bids[0].price);
        const bestAskPrice = parseFloat(orderbook.asks[0].price);
        const spread = bestAskPrice - bestBidPrice;
        const midPrice = (bestBidPrice + bestAskPrice) / 2;
        const spreadPercentage = midPrice > 0 ? ((spread / midPrice) * 100).toString() : '0';

        return {
            total_bid_liquidity: totalBidLiquidity,
            total_ask_liquidity: totalAskLiquidity,
            best_bid_price: bestBidPrice.toString(),
            best_ask_price: bestAskPrice.toString(),
            spread_percentage: spreadPercentage,
            price_levels: orderbook.bids.length + orderbook.asks.length,
        };
    }

    /**
     * Get liquidity at specific price levels
     */
    async getLiquidityAtLevels(
        tradingPair: string,
        levels: number = 5,
        accessToken?: string
    ): Promise<{
        bid_liquidity: string;
        ask_liquidity: string;
        levels_analyzed: number;
    }> {
        const orderbook = await this.getOrderbookDepth(tradingPair, {
            levels,
            accessToken,
        });

        const bidLiquidity = orderbook.bids
            .slice(0, levels)
            .reduce((sum, level) => sum + parseFloat(level.quantity), 0)
            .toString();

        const askLiquidity = orderbook.asks
            .slice(0, levels)
            .reduce((sum, level) => sum + parseFloat(level.quantity), 0)
            .toString();

        return {
            bid_liquidity: bidLiquidity,
            ask_liquidity: askLiquidity,
            levels_analyzed: Math.min(levels, orderbook.bids.length + orderbook.asks.length),
        };
    }

    // ============================================================================
    // Market Analysis Methods
    // ============================================================================

    /**
     * Get comprehensive orderbook statistics
     */
    async getOrderbookStats(
        tradingPair: string,
        accessToken?: string
    ): Promise<OrderbookStats> {
        const orderbook = await this.getOrderbookSnapshot(tradingPair, accessToken);

        const allPrices = [
            ...orderbook.bids.map(b => parseFloat(b.price)),
            ...orderbook.asks.map(a => parseFloat(a.price)),
        ];

        const totalOrders = orderbook.bids.reduce((sum, b) => sum + b.order_count, 0) +
            orderbook.asks.reduce((sum, a) => sum + a.order_count, 0);

        const totalVolume = [
            ...orderbook.bids.map(b => parseFloat(b.quantity)),
            ...orderbook.asks.map(a => parseFloat(a.quantity)),
        ].reduce((sum, qty) => sum + qty, 0).toString();

        const top5BidLiquidity = orderbook.bids
            .slice(0, 5)
            .reduce((sum, level) => sum + parseFloat(level.quantity), 0)
            .toString();

        const top5AskLiquidity = orderbook.asks
            .slice(0, 5)
            .reduce((sum, level) => sum + parseFloat(level.quantity), 0)
            .toString();

        const top10BidLiquidity = orderbook.bids
            .slice(0, 10)
            .reduce((sum, level) => sum + parseFloat(level.quantity), 0)
            .toString();

        const top10AskLiquidity = orderbook.asks
            .slice(0, 10)
            .reduce((sum, level) => sum + parseFloat(level.quantity), 0)
            .toString();

        return {
            trading_pair: tradingPair,
            total_orders: totalOrders,
            total_volume: totalVolume,
            price_range: {
                min_price: allPrices.length > 0 ? Math.min(...allPrices).toString() : '0',
                max_price: allPrices.length > 0 ? Math.max(...allPrices).toString() : '0',
            },
            liquidity_distribution: {
                top_5_levels_bid: top5BidLiquidity,
                top_5_levels_ask: top5AskLiquidity,
                top_10_levels_bid: top10BidLiquidity,
                top_10_levels_ask: top10AskLiquidity,
            },
        };
    }

    /**
     * Check if there's sufficient liquidity for a market order
     */
    async checkMarketOrderLiquidity(
        tradingPair: string,
        side: 'BUY' | 'SELL',
        quantity: string,
        accessToken?: string
    ): Promise<{
        sufficient: boolean;
        available_liquidity: string;
        required_quantity: string;
        estimated_slippage: string;
        price_impact: string;
    }> {
        const orderbook = await this.getOrderbookSnapshot(tradingPair, accessToken);
        const requiredQty = parseFloat(quantity);

        let availableLiquidity = 0;
        let estimatedSlippage = 0;
        let priceImpact = 0;

        if (side === 'BUY') {
            // For buy orders, check ask side liquidity
            for (const ask of orderbook.asks) {
                availableLiquidity += parseFloat(ask.quantity);
                if (availableLiquidity >= requiredQty) {
                    break;
                }
            }

            if (orderbook.asks.length > 0) {
                const bestAsk = parseFloat(orderbook.asks[0].price);
                // Simple slippage estimation (would need more sophisticated calculation)
                estimatedSlippage = availableLiquidity < requiredQty ?
                    (requiredQty - availableLiquidity) * 0.01 : 0;
                priceImpact = (estimatedSlippage / bestAsk) * 100;
            }
        } else {
            // For sell orders, check bid side liquidity
            for (const bid of orderbook.bids) {
                availableLiquidity += parseFloat(bid.quantity);
                if (availableLiquidity >= requiredQty) {
                    break;
                }
            }

            if (orderbook.bids.length > 0) {
                const bestBid = parseFloat(orderbook.bids[0].price);
                estimatedSlippage = availableLiquidity < requiredQty ?
                    (requiredQty - availableLiquidity) * 0.01 : 0;
                priceImpact = (estimatedSlippage / bestBid) * 100;
            }
        }

        return {
            sufficient: availableLiquidity >= requiredQty,
            available_liquidity: availableLiquidity.toString(),
            required_quantity: quantity,
            estimated_slippage: estimatedSlippage.toString(),
            price_impact: priceImpact.toString(),
        };
    }

    // ============================================================================
    // Utility Methods
    // ============================================================================

    /**
     * Get price levels within a percentage range of mid-price
     */
    async getPriceLevelsInRange(
        tradingPair: string,
        percentageRange: number = 1.0, // 1% by default
        accessToken?: string
    ): Promise<{
        bid_levels: PriceLevel[];
        ask_levels: PriceLevel[];
        range_percentage: number;
    }> {
        const marketPrice = await this.getMarketPrice(tradingPair, accessToken);
        const midPrice = parseFloat(marketPrice.mid_price);
        const range = midPrice * (percentageRange / 100);

        const orderbook = await this.getOrderbookSnapshot(tradingPair, accessToken);

        const bidLevels = orderbook.bids.filter(bid => {
            const price = parseFloat(bid.price);
            return price >= (midPrice - range);
        });

        const askLevels = orderbook.asks.filter(ask => {
            const price = parseFloat(ask.price);
            return price <= (midPrice + range);
        });

        return {
            bid_levels: bidLevels,
            ask_levels: askLevels,
            range_percentage: percentageRange,
        };
    }

    /**
     * Monitor orderbook changes (polling-based)
     */
    async monitorOrderbook(
        tradingPair: string,
        callback: (orderbook: OrderbookSnapshot) => void,
        options?: {
            interval?: number; // milliseconds
            timeout?: number; // milliseconds
            accessToken?: string;
        }
    ): Promise<void> {
        const interval = options?.interval || 1000; // 1 second default
        const timeout = options?.timeout || 60000; // 1 minute default
        const startTime = Date.now();

        const monitor = async () => {
            try {
                const orderbook = await this.getOrderbookSnapshot(tradingPair, options?.accessToken);
                callback(orderbook);

                if (Date.now() - startTime < timeout) {
                    setTimeout(monitor, interval);
                }
            } catch (error) {
                console.error('Error monitoring orderbook:', error);
                if (Date.now() - startTime < timeout) {
                    setTimeout(monitor, interval);
                }
            }
        };

        monitor();
    }

    /**
     * Compare orderbook between two trading pairs
     */
    async compareOrderbooks(
        tradingPair1: string,
        tradingPair2: string,
        accessToken?: string
    ): Promise<{
        pair1: OrderbookSnapshot;
        pair2: OrderbookSnapshot;
        comparison: {
            spread_difference: string;
            liquidity_ratio: string;
            price_difference: string;
        };
    }> {
        const [orderbook1, orderbook2] = await Promise.all([
            this.getOrderbookSnapshot(tradingPair1, accessToken),
            this.getOrderbookSnapshot(tradingPair2, accessToken),
        ]);

        const marketPrice1 = await this.getMarketPrice(tradingPair1, accessToken);
        const marketPrice2 = await this.getMarketPrice(tradingPair2, accessToken);

        const spread1 = parseFloat(marketPrice1.spread);
        const spread2 = parseFloat(marketPrice2.spread);
        const spreadDifference = Math.abs(spread1 - spread2).toString();

        const liquidity1 = await this.getLiquidityInfo(tradingPair1, accessToken);
        const liquidity2 = await this.getLiquidityInfo(tradingPair2, accessToken);

        const liquidityRatio = (parseFloat(liquidity1.total_bid_liquidity) /
            parseFloat(liquidity2.total_bid_liquidity)).toString();

        const priceDifference = Math.abs(parseFloat(marketPrice1.mid_price) -
            parseFloat(marketPrice2.mid_price)).toString();

        return {
            pair1: orderbook1,
            pair2: orderbook2,
            comparison: {
                spread_difference: spreadDifference,
                liquidity_ratio: liquidityRatio,
                price_difference: priceDifference,
            },
        };
    }
}
