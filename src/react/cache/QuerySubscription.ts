import equal from '@wry/equality';
import {
  ApolloError,
  ApolloQueryResult,
  NetworkStatus,
  ObservableQuery,
  OperationVariables,
} from '../../core';
import { isNetworkRequestSettled } from '../../core/networkStatus';
import { Concast, hasDirectives } from '../../utilities';
import { invariant } from '../../utilities/globals';

type Listener<TData> = (result: ApolloQueryResult<TData>) => void;

type FetchMoreOptions<TData> = Parameters<
  ObservableQuery<TData>['fetchMore']
>[0];

interface Subscription {
  unsubscribe: () => void;
}

function wrapWithCustomPromise<TData>(
  concast: Concast<ApolloQueryResult<TData>>
) {
  return new Promise<ApolloQueryResult<TData>>((resolve, reject) => {
    // Unlike `concast.promise`, we want to resolve the promise on the initial
    // chunk of the deferred query. This allows the component to unsuspend
    // when we get the initial set of data, rather than waiting until all
    // chunks have been loaded.
    const subscription = concast.subscribe({
      next: (value) => {
        resolve(value);
        subscription.unsubscribe();
      },
      error: reject,
    });
  });
}

interface Options {
  onDispose?: () => void;
}

export class QuerySubscription<TData = any> {
  public result: ApolloQueryResult<TData>;
  public promise: Promise<ApolloQueryResult<TData>>;
  public readonly observable: ObservableQuery<TData>;

  private subscription: Subscription;
  private listeners = new Set<Listener<TData>>();

  constructor(
    observable: ObservableQuery<TData>,
    options: Options = Object.create(null)
  ) {
    this.listen = this.listen.bind(this);
    this.handleNext = this.handleNext.bind(this);
    this.handleError = this.handleError.bind(this);
    this.observable = observable;
    this.result = observable.getCurrentResult();

    if (options.onDispose) {
      this.onDispose = options.onDispose;
    }

    this.subscription = observable.subscribe({
      next: this.handleNext,
      error: this.handleError,
    });

    // This error should never happen since the `.subscribe` call above
    // will ensure a concast is set on the observable via the `reobserve`
    // call. Unless something is going horribly wrong and completely messing
    // around with the internals of the observable, there should always be a
    // concast after subscribing.
    invariant(
      observable['concast'],
      'Unexpected error: A concast was not found on the observable.'
    );

    const concast = observable['concast'];

    this.promise = hasDirectives(['defer'], observable.query)
      ? wrapWithCustomPromise(concast)
      : concast.promise;
  }

  listen(listener: Listener<TData>) {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  refetch(variables: OperationVariables | undefined) {
    this.promise = this.observable.refetch(variables);

    return this.promise;
  }

  fetchMore(options: FetchMoreOptions<TData>) {
    this.promise = this.observable.fetchMore<TData>(options);

    return this.promise;
  }

  dispose() {
    this.subscription.unsubscribe();
    this.onDispose();
  }

  private onDispose() {
    // noop. overridable by options
  }

  private handleNext(result: ApolloQueryResult<TData>) {
    // If we encounter an error with the new result after we have successfully
    // fetched a previous result, we should set the new result data to the last
    // successful result.
    if (
      isNetworkRequestSettled(result.networkStatus) &&
      this.result.data &&
      result.data === void 0
    ) {
      result.data = this.result.data;
    }

    if (!equal(this.result, result)) {
      this.result = result;
      this.deliver(result);
    }
  }

  private handleError(error: ApolloError) {
    const result = {
      ...this.result,
      error,
      networkStatus: NetworkStatus.error,
    };

    this.result = result;
    this.deliver(result);
  }

  private deliver(result: ApolloQueryResult<TData>) {
    this.listeners.forEach((listener) => listener(result));
  }
}