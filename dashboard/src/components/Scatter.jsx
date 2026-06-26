import React, { useEffect, useRef } from "react";
import * as d3 from "d3";

// Generic D3 scatter / bubble chart.
// points: [{ x, y, r?, color?, label }]
export default function Scatter({ points, xLabel, yLabel, width = 720, height = 460, invertY = false }) {
  const ref = useRef(null);
  const tipRef = useRef(null);

  useEffect(() => {
    const svg = d3.select(ref.current);
    svg.selectAll("*").remove();
    if (!points || points.length === 0) return;

    const margin = { top: 20, right: 24, bottom: 48, left: 60 };
    const w = width - margin.left - margin.right;
    const h = height - margin.top - margin.bottom;

    const g = svg
      .attr("width", width)
      .attr("height", height)
      .append("g")
      .attr("transform", `translate(${margin.left},${margin.top})`);

    const xExtent = d3.extent(points, (d) => d.x);
    const yExtent = d3.extent(points, (d) => d.y);
    const xPad = (xExtent[1] - xExtent[0]) * 0.08 || 0.05;
    const yPad = (yExtent[1] - yExtent[0]) * 0.08 || 0.05;

    const x = d3.scaleLinear().domain([xExtent[0] - xPad, xExtent[1] + xPad]).range([0, w]);
    const yDomain = [yExtent[0] - yPad, yExtent[1] + yPad];
    const y = d3.scaleLinear().domain(invertY ? [yDomain[1], yDomain[0]] : yDomain).range([h, 0]);

    g.append("g").attr("class", "axis").attr("transform", `translate(0,${h})`).call(d3.axisBottom(x).ticks(8));
    g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(8));

    g.append("text").attr("x", w / 2).attr("y", h + 40).attr("text-anchor", "middle")
      .attr("fill", "#9aa3b2").attr("font-size", 12).text(xLabel);
    g.append("text").attr("transform", "rotate(-90)").attr("x", -h / 2).attr("y", -44)
      .attr("text-anchor", "middle").attr("fill", "#9aa3b2").attr("font-size", 12).text(yLabel);

    // median guide lines
    const yMed = d3.median(points, (d) => d.y);
    g.append("line").attr("x1", 0).attr("x2", w).attr("y1", y(yMed)).attr("y2", y(yMed))
      .attr("stroke", "#2a2f3c").attr("stroke-dasharray", "4 4");

    const tip = d3.select(tipRef.current);
    g.selectAll("circle")
      .data(points)
      .join("circle")
      .attr("cx", (d) => x(d.x))
      .attr("cy", (d) => y(d.y))
      .attr("r", (d) => d.r || 6)
      .attr("fill", (d) => d.color || "#5b8cff")
      .attr("opacity", 0.78)
      .attr("stroke", "#0f1117")
      .on("mousemove", (event, d) => {
        tip.style("opacity", 1)
          .style("left", event.pageX + 12 + "px")
          .style("top", event.pageY - 10 + "px")
          .html(`<b>${d.label}</b><br/>${xLabel}: ${d.x.toFixed(3)}<br/>${yLabel}: ${d.y.toFixed(3)}`);
      })
      .on("mouseleave", () => tip.style("opacity", 0));
  }, [points, xLabel, yLabel, width, height, invertY]);

  return (
    <>
      <svg ref={ref} />
      <div className="tooltip" ref={tipRef} />
    </>
  );
}
