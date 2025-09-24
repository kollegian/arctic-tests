/**
 * Base API Client for Monaco Protocol
 *
 * Provides common functionality for all API clients including:
 * - HTTP request handling
 * - Error handling
 * - Response parsing
 * - Authentication headers
 */

export interface ApiResponse<T = any> {
    success: boolean;
    data?: T;
    error?: string;
    message?: string;
}

export interface ApiError {
    status: number;
    message: string;
    details?: any;
}

export class MonacoApiError extends Error {
    public status: number;
    public details?: any;

    constructor(message: string, status: number, details?: any) {
        super(message);
        this.name = 'MonacoApiError';
        this.status = status;
        this.details = details;
    }
}

export abstract class BaseApiClient {
    protected url: string;
    protected clientId: string;

    constructor(url: string, clientId: string) {
        this.url = url.replace(/\/$/, ''); // Remove trailing slash
        this.clientId = clientId;
    }

    /**
     * Make an authenticated HTTP request
     */
    protected async makeRequest<T = any>(
        endpoint: string,
        options: RequestInit = {},
        accessToken?: string
    ): Promise<T> {
        const url = `${this.url}${endpoint}`;

        const headers: HeadersInit = {
            'Content-Type': 'application/json',
            ...options.headers,
        };

        if (accessToken) {
            headers['Authorization' as keyof HeadersInit] = `Bearer ${accessToken}`;
        }

        const requestOptions: RequestInit = {
            ...options,
            headers,
        };

        try {
            const response = await fetch(url, requestOptions);
            let responseData: any;
            const contentType = response.headers.get('content-type');

            if (contentType && contentType.includes('application/json')) {
                responseData = await response.json();
            } else {
                responseData = await response.text();
            }

            if (!response.ok) {
                const errorMessage = responseData?.message || responseData?.error || `HTTP ${response.status}: ${response.statusText}`;
                throw new MonacoApiError(
                    errorMessage,
                    response.status,
                    responseData
                );
            }
            const retData = {responseData, status: response.status};
            return retData as unknown as T;
        } catch (error) {
            if (error instanceof MonacoApiError) {
                throw error;
            }

            throw new MonacoApiError(
                `Network error: ${error instanceof Error ? error.message : 'Unknown error'}`,
                0,
                error
            );
        }
    }


    protected async get<T = any>(endpoint: string, accessToken?: string): Promise<T> {
        return this.makeRequest<T>(endpoint, { method: 'GET' }, accessToken);
    }

    /**
     * Make a POST request
     */
    protected async post<T = any>(endpoint: string, data: any, accessToken?: string): Promise<T> {
        return this.makeRequest<T>(endpoint, {
            method: 'POST',
            body: JSON.stringify(data),
        }, accessToken);
    }

    /**
     * Make a PUT request
     */
    protected async put<T = any>(endpoint: string, data: any, accessToken?: string): Promise<T> {
        return this.makeRequest<T>(endpoint, {
            method: 'PUT',
            body: JSON.stringify(data),
        }, accessToken);
    }

    /**
     * Make a DELETE request
     */
    protected async delete<T = any>(endpoint: string, accessToken?: string): Promise<T> {
        return this.makeRequest<T>(endpoint, { method: 'DELETE' }, accessToken);
    }

    /**
     * Make a GET request without authentication (convenience method)
     */
    protected async getPublic<T = any>(endpoint: string): Promise<T> {
        return this.makeRequest<T>(endpoint, { method: 'GET' });
    }

    /**
     * Build query string from parameters
     */
    protected buildQueryString(params: Record<string, any>): string {
        const searchParams = new URLSearchParams();

        Object.entries(params).forEach(([key, value]) => {
            if (value !== undefined && value !== null) {
                searchParams.append(key, String(value));
            }
        });

        const queryString = searchParams.toString();
        return queryString ? `?${queryString}` : '';
    }

    /**
     * Validate required parameters
     */
    protected validateRequired(params: Record<string, any>, required: string[]): void {
        const missing = required.filter(key => params[key] === undefined || params[key] === null);

        if (missing.length > 0) {
            throw new MonacoApiError(
                `Missing required parameters: ${missing.join(', ')}`,
                400
            );
        }
    }
}

