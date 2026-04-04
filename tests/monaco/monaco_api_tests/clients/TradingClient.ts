import { BaseApiClient, MonacoApiError } from './BaseApiClient';

// ============================================================================
// Type Definitions
// ============================================================================

export type OrderType = 'LIMIT' | 'MARKET';
export type OrderSide = 'BUY' | 'SELL';
export type OrderStatus =
    | 'PENDING'
    | 'SUBMITTED'
    | 'ACKNOWLEDGED'
    | 'PARTIALLY_FILLED'
    | 'FILLED'
    | 'CANCELLED'
    | 'EXPIRED'
    | 'REJECTED';

export type TradingMode = 'SPOT' | 'MARGIN';

// ============================================================================
// Request/Response Interfaces
// ============================================================================

export interface CreateOrderRequest {
    trading_pair: string;
    order_type: OrderType;
    side: OrderSide;
    price?: string;
    quantity: string;
    trading_mode?: TradingMode;
    use_master_balance?: boolean;
    expiration_date?: string;
    slippage_tolerance_bps?: number;
    time_in_force?: string;
}

export interface CreateOrderResponse {
    responseData: {
        order_id: string;
        status: string;
        message: string;
        match_result?: MatchResultInfo;
    },
    status: number,
}

export interface MatchResultInfo {
    trades_count: number;
    total_filled: string;
    remaining_quantity: string;
    average_fill_price?: string;
    status: string;
    actual_slippage_bps: number;
    max_slippage_bps: number;
    execution_price_range: object;
}

export interface CancelOrderRequest {
    order_id: string;
}

export interface CancelOrderResponse {
    responseData: {
        order_id: string;
        status: string;
        message: string;
    }
    status: number,
}

export interface UpdateOrderRequest {
    price?: string;
    quantity?: string;
    use_master_balance?: boolean;
}

export interface UpdateOrderResponse {
    responseData: {
        order_id: string;
        status: string;
        message: string;
        updated_fields: UpdatedFields;
        original_order_id?: string;
        match_result?: MatchResultInfo;
    }
    status: number,
}

export interface UpdatedFields {
    price?: string;
    quantity?: string;
}

export interface OrderResponse {
    responseData: {
        id: string;
        trading_pair: string;
        order_type: string;
        side: string;
        price?: string;
        quantity: string;
        filled_quantity: string;
        average_fill_price?: string;
        remaining_quantity?: string;
        status: string;
        trading_mode: string;
        time_in_force: string;
        expiration_date: string;
        use_master_balance?: boolean;
        created_at: string;
        updated_at?: string;
        monaco_taker_fee: string;
        monaco_maker_rebate: string;
        total_taker_fees: string;
        application_taker_fee:string;
        taker_total_payment: string;
        maker_total_receipt: string;
    }
    status: number,
}

export interface PaginatedOrdersResponse {
    orders: OrderResponse[];
    total: number;
    page: number;
    page_size: number;
    total_pages: number;
}

export interface OrderFilters {
    page?: number;
    page_size?: number;
    status?: OrderStatus;
    trading_pair?: string;
}

export default class TradingClient extends BaseApiClient {
    constructor(url: string, clientId: string) {
        super(url, clientId);
    }

    async placeLimitOrder(
        tokenPair: string,
        side: OrderSide,
        price: string,
        quantity: string,
        accessToken: string,
        options?: {
            trading_mode?: TradingMode;
            use_master_balance?: boolean;
            expiration_date?: string;
            slippage_tolerance_bps?: number;
        }
    ): Promise<CreateOrderResponse> {
        this.validateRequired({ tokenPair, side, price, quantity }, ['tokenPair', 'side', 'price', 'quantity']);

        const request: CreateOrderRequest = {
            trading_pair: tokenPair,
            order_type: 'LIMIT',
            side,
            price,
            quantity,
            trading_mode: options?.trading_mode || 'SPOT',
            use_master_balance: options?.use_master_balance,
            expiration_date: options?.expiration_date,
        };
        return this.post<CreateOrderResponse>('/api/v1/orders', request, accessToken);
    }

    async placeMarketOrder(
        tokenPair: string,
        side: OrderSide,
        quantity: string,
        accessToken: string,
        options?: {
            trading_mode?: TradingMode;
            use_master_balance?: boolean;
            price?: string;
            slippage_tolerance_bps?: number;
            time_in_force?: string;
        },
    ): Promise<CreateOrderResponse> {
        this.validateRequired({ tokenPair, side, quantity }, ['tokenPair', 'side', 'quantity']);

        const request: CreateOrderRequest = {
            trading_pair: tokenPair,
            order_type: 'MARKET',
            side,
            quantity,
            trading_mode: options?.trading_mode || 'SPOT',
            use_master_balance: options?.use_master_balance,
            price: options?.price,
            slippage_tolerance_bps: options?.slippage_tolerance_bps,
            time_in_force: options?.time_in_force || 'GTC',
        };

        return this.post<CreateOrderResponse>('/api/v1/orders', request, accessToken);
    }

    async createOrder(
        request: CreateOrderRequest,
        accessToken: string
    ): Promise<CreateOrderResponse> {
        this.validateRequired(request, ['trading_pair', 'order_type', 'side', 'quantity']);

        // Validate price requirement for LIMIT orders
        if (request.order_type === 'LIMIT' && !request.price) {
            throw new MonacoApiError('Price is required for LIMIT orders', 400);
        }

        return this.post<CreateOrderResponse>('/api/v1/orders', request, accessToken);
    }

    async cancelOrder(orderId: string, accessToken: string): Promise<CancelOrderResponse> {
        this.validateRequired({ orderId }, ['orderId']);

        const request: CancelOrderRequest = {
            order_id: orderId,
        };

        return this.post<CancelOrderResponse>('/api/v1/orders/cancel', request, accessToken);
    }

    async updateOrder(
        orderId: string,
        updates: UpdateOrderRequest,
        accessToken: string
    ): Promise<UpdateOrderResponse> {
        this.validateRequired({ orderId }, ['orderId']);

        if (!updates.price && !updates.quantity && updates.use_master_balance === undefined) {
            throw new MonacoApiError('At least one field must be updated', 400);
        }

        return this.put<UpdateOrderResponse>(`/api/v1/orders/${orderId}`, updates, accessToken);
    }

    async getOrder(orderId: string, accessToken: string): Promise<OrderResponse> {
        this.validateRequired({ orderId }, ['orderId']);

        return this.get<OrderResponse>(`/api/v1/orders/${orderId}`, accessToken);
    }

    async getOrders(
        accessToken: string,
        filters?: OrderFilters
    ): Promise<PaginatedOrdersResponse> {
        const queryString = filters ? this.buildQueryString(filters) : '';
        return this.get<PaginatedOrdersResponse>(`/api/v1/orders${queryString}`, accessToken);
    }

    async getOrdersByStatus(
        status: OrderStatus,
        accessToken: string,
        options?: { page?: number; page_size?: number }
    ): Promise<PaginatedOrdersResponse> {
        return this.getOrders(accessToken, {
            status,
            page: options?.page,
            page_size: options?.page_size,
        });
    }

    async getOrdersByTradingPair(
        tradingPair: string,
        accessToken: string,
        options?: { page?: number; page_size?: number; status?: OrderStatus }
    ): Promise<PaginatedOrdersResponse> {
        return this.getOrders(accessToken, {
            trading_pair: tradingPair,
            page: options?.page,
            page_size: options?.page_size,
            status: options?.status,
        });
    }

    /**
     * Get active orders (PENDING, SUBMITTED, ACKNOWLEDGED, PARTIALLY_FILLED)
     */
    async getActiveOrders(
        accessToken: string,
        options?: { page?: number; page_size?: number; trading_pair?: string }
    ): Promise<PaginatedOrdersResponse> {
        const activeStatuses: OrderStatus[] = ['PENDING', 'SUBMITTED', 'ACKNOWLEDGED', 'PARTIALLY_FILLED'];

        // Get all active orders by making multiple requests
        const allOrders: OrderResponse[] = [];
        let totalPages = 1;
        let currentPage = 1;

        do {
            const response = await this.getOrders(accessToken, {
                page: currentPage,
                page_size: options?.page_size || 100,
                trading_pair: options?.trading_pair,
            });

            // Filter for active statuses
            const activeOrders = response.orders.filter(order =>
                activeStatuses.includes(order.status as OrderStatus)
            );

            allOrders.push(...activeOrders);
            totalPages = response.total_pages;
            currentPage++;
        } while (currentPage <= totalPages);

        return {
            orders: allOrders,
            total: allOrders.length,
            page: 1,
            page_size: allOrders.length,
            total_pages: 1,
        };
    }

    /**
     * Get filled orders
     */
    async getFilledOrders(
        accessToken: string,
        options?: { page?: number; page_size?: number; trading_pair?: string }
    ): Promise<PaginatedOrdersResponse> {
        return this.getOrdersByStatus('FILLED', accessToken, {
            page: options?.page,
            page_size: options?.page_size,
        });
    }

    /**
     * Get cancelled orders
     */
    async getCancelledOrders(
        accessToken: string,
        options?: { page?: number; page_size?: number; trading_pair?: string }
    ): Promise<PaginatedOrdersResponse> {
        return this.getOrdersByStatus('CANCELLED', accessToken, {
            page: options?.page,
            page_size: options?.page_size,
        });
    }

    // ============================================================================
    // Utility Methods
    // ============================================================================

    /**
     * Wait for order to reach a specific status
     */
    async waitForOrderStatus(
        orderId: string,
        targetStatus: OrderStatus,
        accessToken: string,
        options?: {
            timeout?: number; // milliseconds
            pollInterval?: number; // milliseconds
        }
    ): Promise<OrderResponse> {
        const timeout = options?.timeout || 30000; // 30 seconds default
        const pollInterval = options?.pollInterval || 1000; // 1 second default
        const startTime = Date.now();

        while (Date.now() - startTime < timeout) {
            try {
                const order = await this.getOrder(orderId, accessToken);

                if (order.status === targetStatus) {
                    return order;
                }

                // If order is in a terminal state, throw error
                const terminalStatuses: OrderStatus[] = ['CANCELLED', 'REJECTED', 'EXPIRED'];
                if (terminalStatuses.includes(order.status as OrderStatus)) {
                    throw new MonacoApiError(
                        `Order ${orderId} reached terminal status: ${order.status}`,
                        400
                    );
                }

                // Wait before next poll
                await new Promise(resolve => setTimeout(resolve, pollInterval));
            } catch (error) {
                if (error instanceof MonacoApiError) {
                    throw error;
                }
                // Continue polling on network errors
                await new Promise(resolve => setTimeout(resolve, pollInterval));
            }
        }

        throw new MonacoApiError(
            `Timeout waiting for order ${orderId} to reach status ${targetStatus}`,
            408
        );
    }

    /**
     * Get order summary with key information
     */
    async getOrderSummary(orderId: string, accessToken: string): Promise<{
        id: string;
        trading_pair: string;
        side: OrderSide;
        type: OrderType;
        quantity: string;
        price?: string;
        status: OrderStatus;
        created_at: string;
        filled_quantity: string;
        remaining_quantity: string;
    }> {
        const order = await this.getOrder(orderId, accessToken);

        const remainingQuantity = (parseFloat(order.quantity) - parseFloat(order.filled_quantity)).toString();

        return {
            id: order.id,
            trading_pair: order.trading_pair,
            side: order.side as OrderSide,
            type: order.order_type as OrderType,
            quantity: order.quantity,
            price: order.price,
            status: order.status as OrderStatus,
            created_at: order.created_at,
            filled_quantity: order.filled_quantity,
            remaining_quantity: remainingQuantity,
        };
    }

    /**
     * Cancel all active orders for a trading pair
     */
    async cancelAllOrdersForPair(
        tradingPair: string,
        accessToken: string
    ): Promise<CancelOrderResponse[]> {
        const activeOrders = await this.getActiveOrders(accessToken, { trading_pair: tradingPair });

        const cancelPromises = activeOrders.orders.map(order =>
            this.cancelOrder(order.id, accessToken)
        );

        return Promise.all(cancelPromises);
    }


    async getTradingStats(
        accessToken: string,
        options?: { trading_pair?: string; days?: number }
    ): Promise<{
        total_orders: number;
        filled_orders: number;
        cancelled_orders: number;
        total_volume: string;
        success_rate: number;
    }> {
        const allOrders = await this.getOrders(accessToken, {
            trading_pair: options?.trading_pair,
            page_size: 1000, // Get more orders for stats
        });

        const totalOrders = allOrders.total;
        const filledOrders = allOrders.orders.filter(o => o.status === 'FILLED').length;
        const cancelledOrders = allOrders.orders.filter(o => o.status === 'CANCELLED').length;

        // Calculate total volume (simplified - would need more complex logic for accurate calculation)
        const totalVolume = allOrders.orders
            .filter(o => o.status === 'FILLED')
            .reduce((sum, order) => {
                const quantity = parseFloat(order.quantity);
                const price = order.price ? parseFloat(order.price) : 0;
                return sum + (quantity * price);
            }, 0)
            .toString();

        const successRate = totalOrders > 0 ? (filledOrders / totalOrders) * 100 : 0;

        return {
            total_orders: totalOrders,
            filled_orders: filledOrders,
            cancelled_orders: cancelledOrders,
            total_volume: totalVolume,
            success_rate: Math.round(successRate * 100) / 100,
        };
    }
}
