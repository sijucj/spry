---
sqlpage-conf:
  database_url: "postgresql://postgres:uO1YE4eK7yK3wT@10.10.10.171:6796/subin_fopc_simt_prime"
  web_root: "./"
  allow_exec: true
  port: 9212
  listen_on: "0.0.0.0:8080"
---

## FixedOps Performance Center

1. Build the SQLPage notebook page from `README.md` and pipe it into the database:
  
   ```bash
   deno run -A https://raw.githubusercontent.com/programmablemd/spry/refs/heads/main/lib/sqlpage/spry.ts --md README.md --package --conf sqlpage/sqlpage.json 
   ```

2. Start the SQLPage server:

   - Linux (from repository root): `SQLPAGE_SITE_PREFIX="" sqlpage.bin`

```sql index.sql { route: { caption: "Home" } }
-- FOPC Home Page
SELECT 'shell' as component,
       'Fixed Ops Performance Center' as title,
       '/theme/fopc.css' as css,
       'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css' as css;

-- FOPC Header
SELECT 'html' as component,
'<div class="fopc-header">
    <div style="display: flex; align-items: center; gap: 15px;">
        <div style="background: white; padding: 8px; border-radius: 4px; color: #333; font-weight: bold;">ARMATUS</div>
        <div style="display: flex; flex-direction: column; font-size: 12px;">
            <div style="font-weight: bold; font-size: 14px;">USA Auto Group</div>
            <div>USA Chevy Superstore, VA</div>
        </div>
    </div>
    <div style="font-size: 20px; font-weight: 600;">Fixed Ops Performance Center</div>
    <div style="display: flex; align-items: center; gap: 15px;">
        <input type="text" placeholder="Search by RO#" style="background: rgba(255,255,255,0.9); border: none; padding: 6px 12px; border-radius: 4px; min-width: 200px;">
        <div style="display: flex; align-items: center; gap: 10px;">
            <span>Hi, User</span>
            <i class="fas fa-user-circle" style="font-size: 20px;"></i>
        </div>
    </div>
</div>' as html;

-- Navigation using list component
SELECT 'list' as component,
       'Navigation' as title;
SELECT 'Home' as title, '/' as link, 'home' as icon, true as active;
SELECT 'Opcode Categorizations' as title, '/opcode_categorizations' as link, 'tags' as icon;
SELECT 'Store Settings' as title, '/store_settings' as link, 'cogs' as icon;
SELECT 'KPI Scorecard' as title, '/kpi_scorecard' as link, 'chart-line' as icon;
SELECT 'Repair Orders' as title, '/repair_orders' as link, 'wrench' as icon;

-- Page content
SELECT 'text' as component,
       'Welcome to FOPC' as title,
       'Fixed Ops Performance Center - SQLPage Implementation' as contents;

-- Quick stats
SELECT 'big_number' as component,
       'Quick Statistics' as title;

SELECT 
    COUNT(*)::TEXT as value,
    'Total Opcodes' as label,
    'primary' as color
FROM opcode_categorizations;

SELECT 
    COUNT(CASE WHEN op_category = 'MAINTENANCE' THEN 1 END)::TEXT as value,
    'Maintenance Opcodes' as label,
    'success' as color
FROM opcode_categorizations;

SELECT 
    COUNT(CASE WHEN op_category = 'REPAIR' THEN 1 END)::TEXT as value,
    'Repair Opcodes' as label,
    'warning' as color
FROM opcode_categorizations;

-- Navigation cards
SELECT 'card' as component,
       'Available Modules' as title;

SELECT 
    'Manage opcode categorizations, labor rates, and service classifications.' as description,
    '[Go to Opcodes](/opcode_categorizations)' as footer;

SELECT 'card' as component,
       'Store Settings' as title;

SELECT 
    'Configure store timezone, working days, fees, and operational parameters.' as description,
    '[Go to Settings](/store_settings)' as footer;

SELECT 'card' as component,
       'KPI Dashboard' as title;

SELECT 
    'View key performance indicators and business metrics.' as description,
    '[Go to Dashboard](/kpi_scorecard)' as footer;
```