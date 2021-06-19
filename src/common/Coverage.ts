/**
 * Copyright 2017 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { assert } from './assert.js';
import { helper, debugError, PuppeteerEventListener } from './helper.js';
import { Protocol } from 'devtools-protocol';
import { CDPSession } from './Connection.js';

import { EVALUATION_SCRIPT_URL } from './ExecutionContext.js';

/**
 * @internal
 */
export { PuppeteerEventListener };

/**
 * The CoverageEntry class represents one entry of the coverage report.
 * @public
 */
export interface CoverageEntry {
  /**
   * The URL of the style sheet or script.
   */
  url: string;
  /**
   * The content of the style sheet or script.
   */
  text: string;
  /**
   * The covered range as start and end positions.
   */
  ranges: Array<{ start: number; end: number }>;
}

/**
 * Set of configurable options for JS coverage.
 * @public
 */
export interface JSCoverageOptions {
  /**
   * Whether to reset coverage on every navigation.
   */
  resetOnNavigation?: boolean;
  /**
   * Whether anonymous scripts generated by the page should be reported.
   */
  reportAnonymousScripts?: boolean;
}

/**
 * Set of configurable options for CSS coverage.
 * @public
 */
export interface CSSCoverageOptions {
  /**
   * Whether to reset coverage on every navigation.
   */
  resetOnNavigation?: boolean;
}

/**
 * The Coverage class provides methods to gathers information about parts of
 * JavaScript and CSS that were used by the page.
 *
 * @remarks
 * To output coverage in a form consumable by {@link https://github.com/istanbuljs | Istanbul},
 * see {@link https://github.com/istanbuljs/puppeteer-to-istanbul | puppeteer-to-istanbul}.
 *
 * @example
 * An example of using JavaScript and CSS coverage to get percentage of initially
 * executed code:
 * ```js
 * // Enable both JavaScript and CSS coverage
 * await Promise.all([
 *   page.coverage.startJSCoverage(),
 *   page.coverage.startCSSCoverage()
 * ]);
 * // Navigate to page
 * await page.goto('https://example.com');
 * // Disable both JavaScript and CSS coverage
 * const [jsCoverage, cssCoverage] = await Promise.all([
 *   page.coverage.stopJSCoverage(),
 *   page.coverage.stopCSSCoverage(),
 * ]);
 * let totalBytes = 0;
 * let usedBytes = 0;
 * const coverage = [...jsCoverage, ...cssCoverage];
 * for (const entry of coverage) {
 *   totalBytes += entry.text.length;
 *   for (const range of entry.ranges)
 *     usedBytes += range.end - range.start - 1;
 * }
 * console.log(`Bytes used: ${usedBytes / totalBytes * 100}%`);
 * ```
 * @public
 */
export class Coverage {
  /**
   * @internal
   */
  _jsCoverage: JSCoverage;
  /**
   * @internal
   */
  _cssCoverage: CSSCoverage;

  constructor(client: CDPSession) {
    this._jsCoverage = new JSCoverage(client);
    this._cssCoverage = new CSSCoverage(client);
  }

  /**
   * @param options - Set of configurable options for coverage defaults to `{
   * resetOnNavigation : true, reportAnonymousScripts : false }`
   * @returns Promise that resolves when coverage is started.
   *
   * @remarks
   * Anonymous scripts are ones that don't have an associated url. These are
   * scripts that are dynamically created on the page using `eval` or
   * `new Function`. If `reportAnonymousScripts` is set to `true`, anonymous
   * scripts will have `__puppeteer_evaluation_script__` as their URL.
   */
  async startJSCoverage(options: JSCoverageOptions = {}): Promise<void> {
    return await this._jsCoverage.start(options);
  }

  /**
   * @returns Promise that resolves to the array of coverage reports for
   * all scripts.
   *
   * @remarks
   * JavaScript Coverage doesn't include anonymous scripts by default.
   * However, scripts with sourceURLs are reported.
   */
  async stopJSCoverage(): Promise<CoverageEntry[]> {
    return await this._jsCoverage.stop();
  }

  /**
   * @param options - Set of configurable options for coverage, defaults to `{
   * resetOnNavigation : true }`
   * @returns Promise that resolves when coverage is started.
   */
  async startCSSCoverage(options: CSSCoverageOptions = {}): Promise<void> {
    return await this._cssCoverage.start(options);
  }

  /**
   * @returns Promise that resolves to the array of coverage reports
   * for all stylesheets.
   * @remarks
   * CSS Coverage doesn't include dynamically injected style tags
   * without sourceURLs.
   */
  async stopCSSCoverage(): Promise<CoverageEntry[]> {
    return await this._cssCoverage.stop();
  }
}

/**
 * @public
 */
export class JSCoverage {
  _client: CDPSession;
  _enabled = false;
  _scriptURLs = new Map<string, string>();
  _scriptSources = new Map<string, string>();
  _eventListeners: PuppeteerEventListener[] = [];
  _resetOnNavigation = false;
  _reportAnonymousScripts = false;

  constructor(client: CDPSession) {
    this._client = client;
  }

  async start(
    options: {
      resetOnNavigation?: boolean;
      reportAnonymousScripts?: boolean;
    } = {}
  ): Promise<void> {
    assert(!this._enabled, 'JSCoverage is already enabled');
    const { resetOnNavigation = true, reportAnonymousScripts = false } =
      options;
    this._resetOnNavigation = resetOnNavigation;
    this._reportAnonymousScripts = reportAnonymousScripts;
    this._enabled = true;
    this._scriptURLs.clear();
    this._scriptSources.clear();
    this._eventListeners = [
      helper.addEventListener(
        this._client,
        'Debugger.scriptParsed',
        this._onScriptParsed.bind(this)
      ),
      helper.addEventListener(
        this._client,
        'Runtime.executionContextsCleared',
        this._onExecutionContextsCleared.bind(this)
      ),
    ];
    await Promise.all([
      this._client.send('Profiler.enable'),
      this._client.send('Profiler.startPreciseCoverage', {
        callCount: false,
        detailed: true,
      }),
      this._client.send('Debugger.enable'),
      this._client.send('Debugger.setSkipAllPauses', { skip: true }),
    ]);
  }

  _onExecutionContextsCleared(): void {
    if (!this._resetOnNavigation) return;
    this._scriptURLs.clear();
    this._scriptSources.clear();
  }

  async _onScriptParsed(
    event: Protocol.Debugger.ScriptParsedEvent
  ): Promise<void> {
    // Ignore puppeteer-injected scripts
    if (event.url === EVALUATION_SCRIPT_URL) return;
    // Ignore other anonymous scripts unless the reportAnonymousScripts option is true.
    if (!event.url && !this._reportAnonymousScripts) return;
    try {
      const response = await this._client.send('Debugger.getScriptSource', {
        scriptId: event.scriptId,
      });
      this._scriptURLs.set(event.scriptId, event.url);
      this._scriptSources.set(event.scriptId, response.scriptSource);
    } catch (error) {
      // This might happen if the page has already navigated away.
      debugError(error);
    }
  }

  async stop(): Promise<CoverageEntry[]> {
    assert(this._enabled, 'JSCoverage is not enabled');
    this._enabled = false;

    const result = await Promise.all<
      Protocol.Profiler.TakePreciseCoverageResponse,
      void,
      void,
      void
    >([
      this._client.send('Profiler.takePreciseCoverage'),
      this._client.send('Profiler.stopPreciseCoverage'),
      this._client.send('Profiler.disable'),
      this._client.send('Debugger.disable'),
    ]);

    helper.removeEventListeners(this._eventListeners);

    const coverage = [];
    const profileResponse = result[0];

    for (const entry of profileResponse.result) {
      let url = this._scriptURLs.get(entry.scriptId);
      if (!url && this._reportAnonymousScripts)
        url = 'debugger://VM' + entry.scriptId;
      const text = this._scriptSources.get(entry.scriptId);
      if (text === undefined || url === undefined) continue;
      const flattenRanges = [];
      for (const func of entry.functions) flattenRanges.push(...func.ranges);
      const ranges = convertToDisjointRanges(flattenRanges);
      coverage.push({ url, ranges, text });
    }
    return coverage;
  }
}

/**
 * @public
 */
export class CSSCoverage {
  _client: CDPSession;
  _enabled = false;
  _stylesheetURLs = new Map<string, string>();
  _stylesheetSources = new Map<string, string>();
  _eventListeners: PuppeteerEventListener[] = [];
  _resetOnNavigation = false;
  _reportAnonymousScripts = false;

  constructor(client: CDPSession) {
    this._client = client;
  }

  async start(options: { resetOnNavigation?: boolean } = {}): Promise<void> {
    assert(!this._enabled, 'CSSCoverage is already enabled');
    const { resetOnNavigation = true } = options;
    this._resetOnNavigation = resetOnNavigation;
    this._enabled = true;
    this._stylesheetURLs.clear();
    this._stylesheetSources.clear();
    this._eventListeners = [
      helper.addEventListener(
        this._client,
        'CSS.styleSheetAdded',
        this._onStyleSheet.bind(this)
      ),
      helper.addEventListener(
        this._client,
        'Runtime.executionContextsCleared',
        this._onExecutionContextsCleared.bind(this)
      ),
    ];
    await Promise.all([
      this._client.send('DOM.enable'),
      this._client.send('CSS.enable'),
      this._client.send('CSS.startRuleUsageTracking'),
    ]);
  }

  _onExecutionContextsCleared(): void {
    if (!this._resetOnNavigation) return;
    this._stylesheetURLs.clear();
    this._stylesheetSources.clear();
  }

  async _onStyleSheet(event: Protocol.CSS.StyleSheetAddedEvent): Promise<void> {
    const header = event.header;
    // Ignore anonymous scripts
    if (!header.sourceURL) return;
    try {
      const response = await this._client.send('CSS.getStyleSheetText', {
        styleSheetId: header.styleSheetId,
      });
      this._stylesheetURLs.set(header.styleSheetId, header.sourceURL);
      this._stylesheetSources.set(header.styleSheetId, response.text);
    } catch (error) {
      // This might happen if the page has already navigated away.
      debugError(error);
    }
  }

  async stop(): Promise<CoverageEntry[]> {
    assert(this._enabled, 'CSSCoverage is not enabled');
    this._enabled = false;
    const ruleTrackingResponse = await this._client.send(
      'CSS.stopRuleUsageTracking'
    );
    await Promise.all([
      this._client.send('CSS.disable'),
      this._client.send('DOM.disable'),
    ]);
    helper.removeEventListeners(this._eventListeners);

    // aggregate by styleSheetId
    const styleSheetIdToCoverage = new Map();
    for (const entry of ruleTrackingResponse.ruleUsage) {
      let ranges = styleSheetIdToCoverage.get(entry.styleSheetId);
      if (!ranges) {
        ranges = [];
        styleSheetIdToCoverage.set(entry.styleSheetId, ranges);
      }
      ranges.push({
        startOffset: entry.startOffset,
        endOffset: entry.endOffset,
        count: entry.used ? 1 : 0,
      });
    }

    const coverage = [];
    for (const styleSheetId of this._stylesheetURLs.keys()) {
      const url = this._stylesheetURLs.get(styleSheetId);
      const text = this._stylesheetSources.get(styleSheetId);
      const ranges = convertToDisjointRanges(
        styleSheetIdToCoverage.get(styleSheetId) || []
      );
      coverage.push({ url, ranges, text });
    }

    return coverage;
  }
}

function convertToDisjointRanges(
  nestedRanges: Array<{ startOffset: number; endOffset: number; count: number }>
): Array<{ start: number; end: number }> {
  const points = [];
  for (const range of nestedRanges) {
    points.push({ offset: range.startOffset, type: 0, range });
    points.push({ offset: range.endOffset, type: 1, range });
  }
  // Sort points to form a valid parenthesis sequence.
  points.sort((a, b) => {
    // Sort with increasing offsets.
    if (a.offset !== b.offset) return a.offset - b.offset;
    // All "end" points should go before "start" points.
    if (a.type !== b.type) return b.type - a.type;
    const aLength = a.range.endOffset - a.range.startOffset;
    const bLength = b.range.endOffset - b.range.startOffset;
    // For two "start" points, the one with longer range goes first.
    if (a.type === 0) return bLength - aLength;
    // For two "end" points, the one with shorter range goes first.
    return aLength - bLength;
  });

  const hitCountStack = [];
  const results = [];
  let lastOffset = 0;
  // Run scanning line to intersect all ranges.
  for (const point of points) {
    if (
      hitCountStack.length &&
      lastOffset < point.offset &&
      hitCountStack[hitCountStack.length - 1] > 0
    ) {
      const lastResult = results.length ? results[results.length - 1] : null;
      if (lastResult && lastResult.end === lastOffset)
        lastResult.end = point.offset;
      else results.push({ start: lastOffset, end: point.offset });
    }
    lastOffset = point.offset;
    if (point.type === 0) hitCountStack.push(point.range.count);
    else hitCountStack.pop();
  }
  // Filter out empty ranges.
  return results.filter((range) => range.end - range.start > 1);
}
