## Cramer’s Rule for 2×2 Systems

Cramer’s Rule is a method that uses determinants to solve systems of equations that have the same number of equations as variables.

Consider a system of two linear equations in two variables.

$$\begin{array}{rcl} a_{1} x + b_{1} y & = & c_{1} \\ a_{2} x + b_{2} y & = & c_{2} \end{array}$$

The solution using Cramer’s Rule is given as

$$x = \frac{D_{x}}{D} = \frac{\left| \begin{array}{cc} c_{1} & b_{1} \\ c_{2} & b_{2} \end{array} \right|}{\left| \begin{array}{cc} a_{1} & b_{1} \\ a_{2} & b_{2} \end{array} \right|}, \quad D \neq 0; \quad y = \frac{D_{y}}{D} = \frac{\left| \begin{array}{cc} a_{1} & c_{1} \\ a_{2} & c_{2} \end{array} \right|}{\left| \begin{array}{cc} a_{1} & b_{1} \\ a_{2} & b_{2} \end{array} \right|}, \quad D \neq 0.$$

If we are solving for $x$, the $x$ column is replaced with the constant column. If we are solving for $y$, the $y$ column is replaced with the constant column.

## Example 2

### Using Cramer’s Rule to Solve a 2 × 2 System

Solve the following $2 \times 2$ system using Cramer’s Rule.

$$\begin{array}{rcl} 12x + 3y & = & 15 \\ 2x - 3y & = & 13 \end{array}$$

### Solution

Solve for $x$.

$$x = \frac{D_{x}}{D} = \frac{\left| \begin{array}{cc} 15 & 3 \\ 13 & -3 \end{array} \right|}{\left| \begin{array}{cc} 12 & 3 \\ 2 & -3 \end{array} \right|} = \frac{-45 - 39}{-36 - 6} = \frac{-84}{-42} = 2$$

Solve for $y$.

$$y = \frac{D_{y}}{D} = \frac{\left| \begin{array}{cc} 12 & 15 \\ 2 & 13 \end{array} \right|}{\left| \begin{array}{cc} 12 & 3 \\ 2 & -3 \end{array} \right|} = \frac{156 - 30}{-36 - 6} = -\frac{126}{42} = -3$$

The solution is $(2, -3)$.
