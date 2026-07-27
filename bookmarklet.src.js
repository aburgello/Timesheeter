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
    '<p style="margin:0 0 20px;color:#64748b;font-size:14px;">Paste the JSON backup exported from your XYi Tracker below. Ensure you are on the correct Day tab first.</p>' +
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

    // Once rows exist on the page a second run would duplicate every one of
    // them, so the run button is removed outright rather than left looking
    // clickable. Close is then the only action.
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
      function getVal(secs) {
        if (!secs || secs === 0) return "";
        var r = Math.round((secs / 3600) * 2) / 2;
        if (r === 0 && secs > 0) r = 0.5;
        return r === 0 ? "" : r.toFixed(1);
      }
      function esc(s) {
        return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
          return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
        });
      }
      function hrs(secs) {
        var v = getVal(secs);
        return v ? v + "h" : "—";
      }
      function describe(t) {
        return [t.filmTitle, t.client, t.projectDescription, t.notes]
          .filter(Boolean).join(" · ");
      }

      // Anything that couldn't be placed still has to be logged by hand, so the
      // report has to carry enough detail to retype the row without going back
      // to the Tracker — job, what it was, time, territory.
      function showReport(filled, total, skipped, warnings) {
        var h = "";
        h += '<div style="font-size:14px;font-weight:bold;color:#1e293b;margin-bottom:12px;">' +
             "Filled " + filled + " of " + total + " rows for " + esc(activeDay) + ".</div>";

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

      var planned = [], skipped = [];
      dailyTasks.forEach(function (task) {
        var r = resolve(task.jobNumber);
        if (r.val !== undefined) planned.push({ task: task, val: r.val });
        else skipped.push({ task: task, why: r.err });
      });

      if (!planned.length) {
        showReport(0, dailyTasks.length, skipped, []);
        if (populated) finish(); else reset("Populate Rows");
        return;
      }

      // Rows are added newest-first by the page, so walk the plan in reverse to
      // preserve the tracker's ordering.
      var warnings = [];
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

        // val() silently no-ops when the value isn't an option, which would
        // leave the time blank with no clue why — so verify each one.
        var want = getVal(task.rawSeconds);
        var $time = $row.find("select[name='timeSelector']:visible");
        $time.val(want);
        if (want && $time.val() !== want) warnings.push(task.jobNumber + ": time " + want + "h not selectable");

        var wantOt = getVal(task.additionalSeconds);
        var $ot = $row.find("select[name='timeSelectorOvertime']:visible");
        $ot.val(wantOt);
        if (wantOt && $ot.val() !== wantOt) warnings.push(task.jobNumber + ": overtime " + wantOt + "h not selectable");

        if (task.clientAmends) $row.find("input[name='isClientAmend']").prop("checked", true);
        if (task.is3D) $row.find("input[name='is3dWorkItem']").prop("checked", true);

        var $ctryCb = $("#countrySelector .ctry input").filter(function () {
          return $(this).attr("data-country-name") === task.territory;
        });
        if ($ctryCb.length) {
          $row.find("[name='countriesSelectedCsv']").val($ctryCb.val());
          $row.find(".jqCountriesText").html(task.territory);
        } else if (task.territory) {
          warnings.push(task.jobNumber + ": territory \"" + task.territory + "\" not found");
        }

        timesheetRowUpdateCheck($row);
        await new Promise(function (r) { setTimeout(r, 600); });
      }

      if (!skipped.length && !warnings.length) {
        document.body.removeChild(overlay);
        alert("Filled all " + planned.length + " rows for " + activeDay + ".");
        return;
      }

      showReport(planned.length, dailyTasks.length, skipped, warnings);
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
