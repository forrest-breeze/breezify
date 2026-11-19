import { describe, expect, it } from 'vitest'
import { readmeBodyToMarkdown } from './readme-markdown'

// Trimmed copies of the JSX layouts in the Merchant Settlement Guide.
const cards = `<style>{\`
  .yb-cards { background: #fff; }
\`}</style>

Intro.

<div className="yb-cards" style={{display: "flex", gap: "20px"}}>

  <div style={{flex: 1, border: "1.5px solid #a7f3d0", background: "#ecfdf5"}}>
    <div style={{display: "flex", alignItems: "center"}}>
      <div style={{background: "#10b981", width: "10px", height: "10px"}}></div>
      <p style={{margin: "0", color: "#047857"}}>Balance #1 · Settlement Balance</p>
    </div>
    <p style={{fontWeight: 700}}>Holds everything your users pay you</p>
    <p>Money your users have paid.</p>
  </div>

  <div style={{flex: 1, border: "1.5px solid #bfdbfe", background: "#eff6ff"}}>
    <div style={{display: "flex"}}>
      <div style={{background: "#3b82f6", width: "10px", height: "10px"}}></div>
      <p style={{color: "#1e40af"}}>Balance #2 · Payout Wallet</p>
    </div>
    <p>Funds instant withdrawals</p>
    <p>It funds your users' withdrawals.</p>
  </div>

</div>

After.`

const steps = `<div className="esd-grid" style={{display: "grid"}}>
  <div className="esd-card" style={{border: "1px solid #e2e8f0"}}>
    <div style={{display: "flex"}}>
      <div style={{background: "#10b981"}}>1</div>
      <p>Settlement day arrives</p>
    </div>
    <p>Breeze evaluates your balance.</p>
    <div style={{background: "#ecfdf5"}}>
      <p>Funds from Mon settled by Thu (T+3)</p>
    </div>
  </div>
  <div className="esd-card">
    <div>
      <div>2</div>
      <p>Payout Wallet top-up</p>
    </div>
    <p>If below the <a href="minimum-balance">Minimum Balance</a>, top up first.</p>
  </div>
</div>`

const timeline = `<div className="gs-diagram" style={{display: "flex", flexDirection: "column"}}>
  <div style={{border: "2px solid #0d9488"}}>
    <p>Week 1–2</p>
    <p>All payin to Payout Wallet</p>
    <p>No merchant settlements are made.</p>
  </div>

  <div style={{display: "flex"}}>
    <div style={{width: "2px", height: "16px", background: "#94a3b8"}} />
    <p>Minimum Balance set by Breeze · after \\~2 weeks</p>
    <div style={{width: 0, height: 0}} />
  </div>

  <div style={{border: "2px solid #10b981"}}>
    <p>Week 2+</p>
    <p>Standard settlement begins</p>
    <p>Regular T+3 settlements start.</p>
  </div>
</div>`

const formula = `<div className="mb-formula-box" style={{display: "flex"}}>
  <div><p>Avg daily payouts</p><p>21-day rolling average</p></div>
  <p>×</p>
  <div><p>3</p><p>days coverage</p></div>
  <p>=</p>
  <p>Minimum Balance</p>
</div>`

const flow = `<div className="fof-outer" style={{padding: "32px"}}>
  <div style={{display: "flex", alignItems: "center"}}>
    <div style={{flex: 1, background: "#ecfdf5", border: "1px solid #a7f3d0"}}><p>Your Users</p></div>
    <div style={{display: "flex", flexDirection: "column"}}>
      <p>pay in</p>
      <div style={{height: "2px", background: "#10b981"}}></div>
    </div>
    <div style={{background: "#10b981"}}><p>Settlement Balance</p></div>
  </div>
  <div style={{display: "flex"}}>
    <div style={{flex: 1}}></div>
    <div style={{width: "90px"}}></div>
    <div style={{display: "flex", flexDirection: "column"}}>
      <div style={{borderLeft: "2.5px dashed #f59e0b", height: "14px"}}></div>
      <p>Top-up</p>
    </div>
  </div>
  <div style={{display: "flex", alignItems: "center"}}>
    <div style={{flex: 1}}></div>
    <div style={{width: "90px"}}></div>
    <div style={{background: "#3b82f6"}}><p>Payout Wallet</p></div>
  </div>
</div>`

describe('ReadMe JSX layouts -> native blocks', () => {
  it('turns side-by-side boxes into toned cards and drops theme styles', () => {
    const markdown = readmeBodyToMarkdown(cards)
    expect(markdown).not.toContain('<style')
    expect(markdown).not.toContain('<div')
    expect(markdown).toContain(
      '{% card title="Holds everything your users pay you" eyebrow="Balance #1 · Settlement Balance" tone="green" %}\nMoney your users have paid.\n{% endcard %}',
    )
    expect(markdown).toContain('eyebrow="Balance #2 · Payout Wallet" tone="blue"')
    expect(markdown).toMatch(/^Intro\.\n\n\{% cards %\}/)
    expect(markdown).toMatch(/\{% endcards %\}\n\nAfter\.$/)
  })

  it('turns numbered boxes into steps with notes and links', () => {
    expect(readmeBodyToMarkdown(steps)).toBe(
      [
        '{% steps %}',
        '{% step title="Settlement day arrives" note="Funds from Mon settled by Thu (T+3)" %}',
        'Breeze evaluates your balance.',
        '{% endstep %}',
        '{% step title="Payout Wallet top-up" %}',
        'If below the [Minimum Balance](minimum-balance), top up first.',
        '{% endstep %}',
        '{% endsteps %}',
      ].join('\n'),
    )
  })

  it('turns boxes joined by a captioned connector into a timeline', () => {
    const markdown = readmeBodyToMarkdown(timeline)
    expect(markdown).toContain(
      '{% phase label="Week 1–2" title="All payin to Payout Wallet" transition="Minimum Balance set by Breeze · after ~2 weeks" %}',
    )
    expect(markdown).toContain('{% phase label="Week 2+" title="Standard settlement begins" %}')
  })

  it('turns operator layouts into a formula', () => {
    expect(readmeBodyToMarkdown(formula)).toBe(
      '{% formula %}Avg daily payouts | 21-day rolling average × 3 | days coverage = Minimum Balance{% endformula %}',
    )
  })

  it('turns rows of boxes and arrows into a Mermaid flowchart', () => {
    const markdown = readmeBodyToMarkdown(flow)
    expect(markdown).toMatch(/^```mermaid\nflowchart LR\n/)
    expect(markdown).toContain('n1 -->|"pay in"| n2')
    expect(markdown).toContain('n2 -.->|"Top-up"| n3')
    expect(markdown).toContain('class n1,n2 green')
  })

  it('keeps unrecognised layouts as paragraphs, never indented code', () => {
    const markdown = readmeBodyToMarkdown('<div style={{padding: "8px"}}>\n  <p>Only <strong>one</strong> line</p>\n</div>')
    expect(markdown).toBe('Only **one** line')
  })

  it('leaves layouts inside code fences alone', () => {
    const source = '```jsx\n<div style={{display: "flex"}}>\n  <p>x</p>\n</div>\n```'
    expect(readmeBodyToMarkdown(source)).toBe(source)
  })
})
