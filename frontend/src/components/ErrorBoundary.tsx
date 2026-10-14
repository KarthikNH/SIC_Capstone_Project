import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
  sectionName?: string;
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error in ErrorBoundary:', error, errorInfo);
  }

  private handleRetry = () => {
    this.setState({ hasError: false, error: null });
    if (this.props.onReset) {
      this.props.onReset();
    }
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="my-4 p-5 border border-red/30 bg-[#fdf8f8] text-ink shadow-2xs">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-full bg-red/10 text-red flex items-center justify-center shrink-0 mt-0.5">
              <AlertTriangle className="w-4 h-4 text-red" />
            </div>
            <div className="flex-1 space-y-1.5">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold text-ink">
                  {this.props.fallbackTitle || 'This section failed to load'}
                </h4>
                {this.props.sectionName && (
                  <span className="text-[10px] font-mono uppercase px-2 py-0.5 bg-red/10 text-red">
                    {this.props.sectionName}
                  </span>
                )}
              </div>
              <p className="text-xs text-[#555] leading-relaxed">
                An unexpected error occurred while rendering this component. You can attempt to reload it without refreshing the page.
              </p>
              {this.state.error?.message && (
                <div className="p-2 bg-white border border-[#e5e7eb] text-[11px] font-mono text-red break-words max-h-24 overflow-y-auto">
                  {this.state.error.message}
                </div>
              )}
              <div className="pt-2">
                <button
                  type="button"
                  onClick={this.handleRetry}
                  className="btn-estate-dark text-xs py-1.5 px-3 flex items-center gap-1.5 hover:bg-charcoal"
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>Retry</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
