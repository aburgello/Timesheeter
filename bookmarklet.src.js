// Source for bookmarklet.txt — edit here, then regenerate:
//   npx esbuild bookmarklet.src.js --minify | sed 's/^/javascript:/' > bookmarklet.txt
//
// Pastes XYi Tracker JSON into the company timesheet page. Relies on page
// globals: jQuery ($), RowAdd(), populateJobInfo(), timesheetRowUpdateCheck().
(function () {
  var overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);z-index:99999;display:flex;justify-content:center;align-items:center;font-family:sans-serif;";
  var modal = document.createElement("div");
  modal.style.cssText =
    "background:#fff;padding:30px;border-radius:12px;width:680px;max-width:92%;box-shadow:0 10px 25px rgba(0,0,0,0.5);";
  modal.innerHTML =
    '<h2 style="margin:0 0 10px;color:#1e293b;">Automate Timesheet</h2>' +
    '<p style="margin:0 0 20px;color:#64748b;font-size:14px;">Paste the JSON backup exported from your XYi Tracker below. Ensure you are on the correct Day tab first. Rows already on this sheet are left alone — anything matching one is reported, not added again.</p>' +
    '<textarea id="xyi-json-input" style="width:100%;height:150px;margin-bottom:20px;padding:10px;border:1px solid #CBD5E1;border-radius:8px;font-family:monospace;font-size:12px;" placeholder=\'{"tasks": [...]}\'></textarea>' +
    '<div id="xyi-report" style="display:none;max-height:340px;overflow:auto;margin-bottom:16px;padding:12px;border-radius:8px;background:#fef2f2;border:1px solid #fecaca;font-size:12px;color:#7f1d1d;white-space:pre-wrap;font-family:monospace;"></div>' +
    '<div style="display:flex;justify-content:flex-end;gap:10px;">' +
    '<button id="xyi-btn-cancel" style="padding:10px 16px;background:#f1f5f9;border:none;border-radius:8px;cursor:pointer;color:#475569;font-weight:bold;">Close</button>' +
    '<button id="xyi-btn-run" style="padding:10px 16px;background:#4f46e5;border:none;border-radius:8px;cursor:pointer;color:#fff;font-weight:bold;">Populate Rows</button>' +
    "</div>";
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  var report = document.getElementById("xyi-report");
  function show(msg) {
    report.style.display = "block";
    report.style.whiteSpace = "pre-wrap";
    report.textContent = msg;
  }

  document.getElementById("xyi-btn-cancel").onclick = function () {
    document.body.removeChild(overlay);
  };

  document.getElementById("xyi-btn-run").onclick = async function () {
    var btn = this;
    btn.innerText = "Processing...";
    btn.style.background = "#94A3B8";
    btn.disabled = true;

    // Re-enabling is only safe before any row has been added — nothing has been
    // written to the page yet, so retrying after fixing the JSON or the day tab
    // is harmless.
    function reset(label) {
      btn.innerText = label || "Populate Rows";
      btn.style.background = "#4f46e5";
      btn.disabled = false;
    }

    // Once rows exist on the page the run button is removed rather than left
    // looking clickable, and Close is the only action. The duplicate check
    // below makes a second run safe for rows that were written in full, but a
    // row a failed run left half-written matches nothing and would be added a
    // second time — so re-running is a decision for a human, not one click.
    function finish() {
      btn.remove();
      var close = document.getElementById("xyi-btn-cancel");
      close.textContent = "Close";
      close.style.background = "#4f46e5";
      close.style.color = "#fff";
    }

    try {
      var data = JSON.parse(document.getElementById("xyi-json-input").value);
      var tasks = data.tasks || [];
      var activeDay = $(".day-tab-titles .selected-day a").text().trim();
      var dailyTasks = tasks.filter(function (t) {
        return t.dayOfWeek === activeDay;
      });
      if (dailyTasks.length === 0) {
        show("No logged jobs found for " + activeDay + " in your JSON data.");
        reset();
        return;
      }

      function norm(s) {
        return (s || "").trim().toUpperCase();
      }

      // Country names have to survive both sides drifting: this site calls it
      // "UK", exports have at times said "United Kingdom", and a stale export
      // sitting in someone's clipboard has to keep working. So match on a
      // punctuation-free key and fold the handful of names that differ.
      var CTRY_ALIASES = {
        UNITEDKINGDOM: "UK",
        GREATBRITAIN: "UK",
        GB: "UK",
        UNITEDSTATES: "USA",
        UNITEDSTATESOFAMERICA: "USA",
        US: "USA",
        UAE: "UNITEDARABEMIRATES",
        // This site's "OV Suite Build" was relabelled "OV Suite Build
        // (Masters)", and the Tracker offers a _Masters_ of its own. Current
        // exports already substitute both, but a JSON sitting in someone's
        // clipboard from before either change still says the old thing and has
        // to land on the checkbox rather than be reported as missing.
        MASTERS: "OVSUITEBUILDMASTERS",
        OVSUITEBUILD: "OVSUITEBUILDMASTERS",
      };
      function ctryKey(s) {
        var k = norm(s).replace(/[^A-Z0-9]/g, "");
        return CTRY_ALIASES[k] || k;
      }
      function hours(secs) {
        return !secs || secs <= 0 ? 0 : secs / 3600;
      }

      // How fine a row may be sliced is decided per *job* by this site — a
      // UK-folder job offers 0.25 steps where an INT one only offers 0.5 — and
      // the export can't know which. So take the row's own dropdown as the
      // authority: read its options and use the nearest one, never going below
      // the smallest real option (rounding a 6-minute log down to nothing would
      // lose the work). The option's own value is returned verbatim, since the
      // site writes them inconsistently ("0.25" on one job, "1.0" on another)
      // and val() silently no-ops on anything that isn't an exact match.
      function snap($select, want) {
        if (!want) return "";
        var opts = $select
          .find("option")
          .map(function () {
            return { val: $(this).val(), num: parseFloat($(this).val()) };
          })
          .get()
          .filter(function (o) {
            return isFinite(o.num) && o.num > 0;
          });
        if (!opts.length) return "";
        // Only positive options are considered, so the smallest one is the
        // floor for free — a 6-minute log lands on 0.25 rather than vanishing.
        // <= so a dead-on tie (1.25h against 0.5 steps) takes the later, larger
        // option: options ascend, and rounding a tie down would quietly bill
        // 15 minutes of real work to nobody.
        var best = opts[0];
        opts.forEach(function (o) {
          if (Math.abs(o.num - want) <= Math.abs(best.num - want)) best = o;
        });
        return best.val;
      }
      function esc(s) {
        return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
          return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
        });
      }
      // Unlogged rows never reach a dropdown, so there's nothing to snap them
      // to — report the true time and let whoever retypes the row pick.
      function hrs(secs) {
        var h = hours(secs);
        return h ? Math.round(h * 100) / 100 + "h" : "—";
      }
      function describe(t) {
        return [t.filmTitle, t.client, t.projectDescription, t.notes]
          .filter(Boolean).join(" · ");
      }

      // Anything that couldn't be placed still has to be logged by hand, so the
      // report has to carry enough detail to retype the row without going back
      // to the Tracker — job, what it was, time, territory.
      function showReport(filled, total, skipped, warnings, dupes) {
        var h = "";
        h += '<div style="font-size:14px;font-weight:bold;color:#1e293b;margin-bottom:12px;">' +
             "Filled " + filled + " of " + total + " rows for " + esc(activeDay) + ".</div>";

        if (dupes && dupes.length) {
          h += '<div style="font-size:13px;font-weight:bold;color:#1e40af;margin:0 0 6px;">' +
               "ALREADY ON THIS SHEET — " + dupes.length + " row" + (dupes.length > 1 ? "s" : "") +
               " left untouched</div>" +
               '<ul style="margin:0 0 12px;padding-left:18px;color:#1e40af;">';
          dupes.forEach(function (d) {
            h += "<li>" + esc(d.task.jobNumber) +
                 (d.task.category ? " · " + esc(d.task.category) : "") +
                 (d.task.territory ? " · " + esc(d.task.territory) : "") +
                 " — check the time on the existing row reads " + hrs(d.task.rawSeconds) + "</li>";
          });
          h += "</ul>";
        }

        if (skipped.length) {
          h += '<div style="font-size:13px;font-weight:bold;color:#7f1d1d;margin:0 0 6px;">' +
               "NOT LOGGED — " + skipped.length + " row" + (skipped.length > 1 ? "s" : "") +
               " you must enter another way</div>";
          h += '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:12px;">';
          h += '<tr style="text-align:left;color:#7f1d1d;"><th style="padding:4px 6px;">Job</th>' +
               '<th style="padding:4px 6px;">Details</th><th style="padding:4px 6px;">Time</th>' +
               '<th style="padding:4px 6px;">Territory</th></tr>';
          skipped.forEach(function (s) {
            var t = s.task;
            var extra = hrs(t.additionalSeconds);
            h += '<tr style="border-top:1px solid #fecaca;">' +
                 '<td style="padding:6px;font-family:monospace;white-space:nowrap;">' + esc(t.jobNumber || "(blank)") + "</td>" +
                 '<td style="padding:6px;">' + esc(describe(t) || t.category || "—") + "</td>" +
                 '<td style="padding:6px;white-space:nowrap;">' + hrs(t.rawSeconds) +
                   (extra !== "—" ? " +" + extra : "") + "</td>" +
                 '<td style="padding:6px;">' + esc(t.territory || "—") + "</td></tr>";
            h += '<tr><td colspan="4" style="padding:0 6px 6px;color:#b91c1c;">↳ ' + esc(s.why) + "</td></tr>";
          });
          h += "</table>";
        }

        if (warnings.length) {
          h += '<div style="font-size:13px;font-weight:bold;color:#92400e;margin:0 0 6px;">' +
               "ADDED BUT INCOMPLETE — check these rows</div><ul style=\"margin:0 0 12px;padding-left:18px;color:#92400e;\">";
          warnings.forEach(function (w) { h += "<li>" + esc(w) + "</li>"; });
          h += "</ul>";
        }

        if (skipped.length) {
          h += '<button id="xyi-copy" style="padding:6px 12px;background:#fff;border:1px solid #fca5a5;border-radius:6px;cursor:pointer;color:#7f1d1d;font-size:12px;">Copy unlogged rows</button>';
        }

        report.style.display = "block";
        report.style.whiteSpace = "normal";
        report.innerHTML = h;

        var copy = document.getElementById("xyi-copy");
        if (copy) {
          copy.onclick = function () {
            var txt = activeDay + " — rows not logged:\n" + skipped.map(function (s) {
              var t = s.task;
              return "• " + (t.jobNumber || "(blank)") + "  " + hrs(t.rawSeconds) +
                     (t.territory ? "  [" + t.territory + "]" : "") +
                     (describe(t) ? "  " + describe(t) : "") + "\n    " + s.why;
            }).join("\n");
            navigator.clipboard.writeText(txt).then(function () {
              copy.textContent = "Copied ✓";
            });
          };
        }
      }

      // The job dropdown is identical on every row, so resolve every task
      // against one option list up front. Nothing is added to the page until we
      // know it can actually be filled — the old version called RowAdd() first
      // and abandoned the row on a miss, leaving a blank row behind.
      var $anySelect = $("select[name='jobSelector']").first();
      var addedProbe = false;
      var populated = false; // any row written to the page yet?
      if (!$anySelect.length) {
        RowAdd();
        await new Promise(function (r) {
          setTimeout(r, 200);
        });
        $anySelect = $("select[name='jobSelector']").first();
        addedProbe = true;
        populated = true;
      }
      if (!$anySelect.length) {
        show("Could not find a job dropdown on this page. Are you on the timesheet Day tab?");
        reset();
        return;
      }

      var options = $anySelect
        .find("option")
        .map(function () {
          return { val: $(this).val(), text: $(this).text() };
        })
        .get();

      function resolve(jobNumber) {
        var want = norm(jobNumber);
        if (!want) return { err: "empty job number in JSON" };

        var exact = options.filter(function (o) {
          return norm(o.text) === want;
        });
        if (exact.length) return { val: exact[0].val };

        var m = want.match(/XY\d{5,6}(?:_[A-Z0-9]+)*/);
        var base = m ? (m[0].match(/XY\d{5,6}/) || [])[0] : null;
        if (!base) {
          return { err: "No XY##### code in this job number, so it can't be matched." };
        }

        var candidates = options.filter(function (o) {
          return norm(o.text).indexOf(base) !== -1;
        });
        if (!candidates.length) {
          // The usual cause: the job is still live in Wrike (so the Tracker
          // imported it happily) but has since been retired from the Job Book
          // on this site, so there is no column to put it in.
          return {
            err: base + " is no longer in the Job Book on this site — it can't be logged here.",
          };
        }

        var suffix = (m[0].slice(base.length).match(/[A-Z0-9]+/g) || []);
        if (!suffix.length) return { val: candidates[0].val };

        var best = null, bestScore = -1;
        candidates.forEach(function (o) {
          var t = norm(o.text);
          var score = suffix.reduce(function (s, tok) {
            return s + (t.indexOf(tok) > -1 ? 1 : 0);
          }, 0);
          if (score > bestScore) { bestScore = score; best = o; }
        });
        return { val: best.val };
      }

      // A row can cover several markets — countriesSelectedCsv is a
      // comma-separated list of checkbox values, so tick every country the task
      // carries and report only the names this site doesn't know. The checkbox
      // list is the page's, not the row's, so this resolves once per task up
      // front — the same values are also what the duplicate check compares on.
      // task.territories arrives from export v6+; older exports (and manual
      // edits) only have the comma-separated territory string.
      function countriesFor(task) {
        var want = task.territories && task.territories.length
          ? task.territories
          : String(task.territory || "").split(",");
        var vals = [], names = [], missing = [];
        want.forEach(function (raw) {
          var name = String(raw).trim();
          if (!name) return;
          var key = ctryKey(name);
          var $cb = $("#countrySelector .ctry input").filter(function () {
            return ctryKey($(this).attr("data-country-name")) === key;
          });
          // Label the row the way this site spells the country, not the way the
          // export did.
          if ($cb.length) {
            vals.push($cb.val());
            names.push($cb.attr("data-country-name"));
          } else missing.push(name);
        });
        return { vals: vals, names: names, missing: missing };
      }

      // Rows already on the sheet are never touched, and a task matching one is
      // not added again: this can be run on a half-filled day, or twice in a
      // day, without doubling anything up. A row counts as the same row when
      // its job, category and countries match — time is deliberately not part
      // of the key, since a row someone started and left short is still that
      // row, not a second one to add. It's reported instead, so the short time
      // gets noticed.
      function rowKey(job, category, countryVals) {
        return [
          String(job || ""),
          norm(category),
          countryVals.slice().sort().join(","),
        ].join("|");
      }
      // Counted, not just flagged, so an export that genuinely holds the same
      // row twice (the same job worked in two sittings) still puts two rows on
      // an empty sheet — and puts none on a sheet that already has both.
      var onSheet = {};
      $(".job-row").each(function () {
        var $r = $(this);
        var job = $r.find("select[name='jobSelector']").val();
        if (!job) return; // a blank row is a placeholder, not a logged row
        var csv = String($r.find("[name='countriesSelectedCsv']").val() || "")
          .split(",")
          .map(function (s) { return s.trim(); })
          .filter(Boolean);
        var cat = $r.find("select[name='categorySelector'] option:selected").text();
        var k = rowKey(job, cat, csv);
        onSheet[k] = (onSheet[k] || 0) + 1;
      });

      var planned = [], skipped = [], dupes = [];
      dailyTasks.forEach(function (task) {
        var r = resolve(task.jobNumber);
        if (r.val === undefined) {
          skipped.push({ task: task, why: r.err });
          return;
        }
        var ctry = countriesFor(task);
        var key = rowKey(r.val, task.category, ctry.vals);
        if (onSheet[key]) {
          onSheet[key]--;
          dupes.push({ task: task });
          return;
        }
        planned.push({ task: task, val: r.val, ctry: ctry });
      });

      if (!planned.length) {
        showReport(0, dailyTasks.length, skipped, [], dupes);
        if (populated) finish(); else reset("Populate Rows");
        return;
      }

      // Rows are added newest-first by the page, so walk the plan in reverse to
      // preserve the tracker's ordering.
      var warnings = [];

      // val() silently no-ops when the value isn't an option, which would leave
      // the time blank with no clue why — so snap to a real option and verify
      // it took. Where the job's grid is coarser than the time logged the row
      // is still correct-as-this-site-allows, but say so: it's a difference
      // between the tracker and the timesheet, and that gets queried later.
      function setTime($sel, task, secs, label) {
        var raw = hours(secs);
        var val = snap($sel, raw);
        $sel.val(val);
        if (!raw) return;
        if (!val || $sel.val() !== val) {
          warnings.push(task.jobNumber + ": " + label + " " +
                        Math.round(raw * 100) / 100 + "h not selectable");
        } else if (Math.abs(parseFloat(val) - raw) >= 0.005) {
          warnings.push(task.jobNumber + ": " + label + " " +
                        Math.round(raw * 100) / 100 + "h logged as " + val +
                        "h — this job's smallest step");
        }
      }

      for (var i = planned.length - 1; i >= 0; i--) {
        var task = planned[i].task;

        if (addedProbe) {
          addedProbe = false; // reuse the probe row for the first entry
        } else {
          RowAdd();
          populated = true;
          await new Promise(function (r) { setTimeout(r, 150); });
        }

        var $row = $(".plus-row").prev(".job-row");
        var $jobSelect = $row.find("select[name='jobSelector']");
        $jobSelect.val(planned[i].val);
        populateJobInfo($row, planned[i].val);

        var $catSelect = $row.find("select[name='categorySelector']");
        var $catOpt = $catSelect.find("option").filter(function () {
          return norm($(this).text()) === norm(task.category);
        });
        if ($catOpt.length) $catSelect.val($catOpt.val());
        else if (task.category) warnings.push(task.jobNumber + ": category \"" + task.category + "\" not in dropdown");

        // Countries go in before the time: the row's time options can depend on
        // what's selected on it, so this has to be settled first. Resolved
        // during planning (see countriesFor).
        var ctry = planned[i].ctry;
        if (ctry.vals.length) {
          $row.find("[name='countriesSelectedCsv']").val(ctry.vals.join(","));
          $row.find(".jqCountriesText").html(ctry.names.join(", "));
        }
        if (ctry.missing.length) {
          warnings.push(task.jobNumber + ": territory \"" + ctry.missing.join("\", \"") + "\" not found");
        }

        setTime($row.find("select[name='timeSelector']:visible"), task, task.rawSeconds, "time");
        setTime($row.find("select[name='timeSelectorOvertime']:visible"), task, task.additionalSeconds, "overtime");

        if (task.clientAmends) $row.find("input[name='isClientAmend']").prop("checked", true);
        if (task.is3D) $row.find("input[name='is3dWorkItem']").prop("checked", true);

        timesheetRowUpdateCheck($row);
        await new Promise(function (r) { setTimeout(r, 600); });
      }

      if (!skipped.length && !warnings.length && !dupes.length) {
        document.body.removeChild(overlay);
        alert("Filled all " + planned.length + " rows for " + activeDay + ".");
        return;
      }

      showReport(planned.length, dailyTasks.length, skipped, warnings, dupes);
      finish();
    } catch (e) {
      show("Error: " + e.message);
      // A failure partway through still leaves real rows on the page, so only
      // offer a retry if nothing was written yet.
      if (populated) finish();
      else reset();
    }
  };
})();
